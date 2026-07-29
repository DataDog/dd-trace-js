'use strict'

const shimmer = require('../../datadog-shimmer')
const nomenclature = require('../../dd-trace/src/service-naming')
const spanEndingHook = require('../../dd-trace/src/opentelemetry/span-ending-hook')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { channel, addHook } = require('./helpers/instrument')

const startChannel = channel('apm:next:request:start')
const finishChannel = channel('apm:next:request:finish')
const errorChannel = channel('apm:next:request:error')
const pageLoadChannel = channel('apm:next:page:load')
const bodyParsedChannel = channel('apm:next:body-parsed')
const queryParsedChannel = channel('apm:next:query-parsed')

const requests = new WeakSet()
const nodeNextRequestsToNextRequests = new WeakMap()

// Next.js <= 14.2.6
const MIDDLEWARE_HEADER = 'x-middleware-invoke'

// Next.js >= 14.2.7
const NEXT_REQUEST_META = Symbol.for('NextInternalRequestMeta')
const META_IS_MIDDLEWARE = 'middlewareInvoke'
const encounteredMiddleware = new WeakSet()

// `next.span_type` value Next.js sets on its own OTel root request span; the whole detection surface.
const NEXT_BASE_SERVER_HANDLE_REQUEST = 'BaseServer.handleRequest'

// In OTel-bridge mode (`plugins: false` + `new tracer.TracerProvider().register()`) Next emits its
// own OTel spans and renames the root request span to `${method} ${route}` at finish, which the
// bridge routes into the DD operation name and leaves the resource as the bare method — the reverse
// of Datadog's contract. Correct it via the bridge's pre-finish hook. See span-ending-hook.js.
spanEndingHook.hook = (ddSpan) => {
  const tags = ddSpan.context().getTags()
  if (tags['next.span_type'] !== NEXT_BASE_SERVER_HANDLE_REQUEST) return

  const method = tags['http.method']
  const route = tags['next.route'] ?? tags['http.route']
  // Next already wrote the RSC-aware `${method} ${route}` into `next.span_name`; prefer it so we
  // mirror Next's own naming, and only construct the resource when it is absent.
  const resource = tags['next.span_name'] ?? (route ? `${method} ${route}` : method)

  ddSpan.setOperationName(nomenclature.opName('web', 'server', 'next'))
  ddSpan.setTag(RESOURCE_NAME, resource)
}

function wrapHandleRequest (handleRequest) {
  return function (req, res, pathname, query) {
    return instrument(req, res, () => handleRequest.apply(this, arguments))
  }
}

function wrapHandleApiRequest (handleApiRequest) {
  return function (req, res, pathname, query) {
    return instrument(req, res, () => {
      const promise = handleApiRequest.apply(this, arguments)

      return promise.then(handled => {
        if (!handled) return handled

        return this.hasPage(pathname).then(pageFound => {
          const pageData = pageFound ? { page: pathname } : getPageFromPath(pathname, this.dynamicRoutes)

          pageLoadChannel.publish(pageData)

          return handled
        })
      })
    })
  }
}

// next 13.2 handleApiRequest uses a different set of parameters
function wrapHandleApiRequestWithMatch (handleApiRequest) {
  return function (req, res, query, match) {
    return instrument(req, res, () => {
      const page = (
        match !== null && typeof match === 'object' && match.definition !== null && typeof match.definition === 'object'
      )
        ? match.definition.pathname
        : undefined

      pageLoadChannel.publish({ page })

      return handleApiRequest.apply(this, arguments)
    })
  }
}

function wrapRenderToHTML (renderToHTML) {
  return function (req, res, pathname, query, parsedUrl) {
    return instrument(req, res, () => renderToHTML.apply(this, arguments))
  }
}

function wrapRenderErrorToHTML (renderErrorToHTML) {
  return function (err, req, res, pathname, query) {
    return instrument(req, res, () => renderErrorToHTML.apply(this, arguments), err)
  }
}

function wrapRenderToResponse (renderToResponse) {
  return function (ctx) {
    return instrument(ctx.req, ctx.res, () => renderToResponse.apply(this, arguments))
  }
}

function wrapRenderErrorToResponse (renderErrorToResponse) {
  return function (ctx, err) {
    return instrument(ctx.req, ctx.res, () => renderErrorToResponse.apply(this, arguments), err)
  }
}

function wrapFindPageComponents (findPageComponents) {
  return function (pathname, query) {
    const result = findPageComponents.apply(this, arguments)

    if (result) {
      pageLoadChannel.publish(getPagePath(pathname))
    }

    return result
  }
}

function getPagePath (maybePage) {
  if (typeof maybePage !== 'object') return { page: maybePage }

  const isAppPath = maybePage.isAppPath
  const page = maybePage.pathname || maybePage.page
  return { page, isAppPath }
}

function getPageFromPath (page, dynamicRoutes = []) {
  for (const dynamicRoute of dynamicRoutes) {
    // eslint-disable-next-line unicorn/prefer-regexp-test
    if (dynamicRoute.page.startsWith('/api') && dynamicRoute.match(page)) {
      return getPagePath(dynamicRoute.page)
    }
  }

  return getPagePath(page)
}

function getRequestMeta (req, key) {
  const meta = req[NEXT_REQUEST_META] || {}
  return typeof key === 'string' ? meta[key] : meta
}

function instrument (req, res, handler, error) {
  req = req.originalRequest || req
  res = res.originalResponse || res

  // TODO support middleware properly in the future?
  const isMiddleware = req.headers[MIDDLEWARE_HEADER] || getRequestMeta(req, META_IS_MIDDLEWARE)
  if ((isMiddleware && !encounteredMiddleware.has(req)) || requests.has(req)) {
    encounteredMiddleware.add(req)
    if (error) {
      errorChannel.publish({ error })
    }
    return handler()
  }

  requests.add(req)

  const ctx = { req, res }
  if (queryParsedChannel.hasSubscribers && req.url) {
    const queryIndex = req.url.indexOf('?')
    if (queryIndex !== -1) {
      const searchParams = new URLSearchParams(req.url.slice(queryIndex + 1))
      const query = {}
      for (const key of searchParams.keys()) {
        if (!query[key]) {
          query[key] = searchParams.getAll(key)
        }
      }

      queryParsedChannel.publish({ query })
    }
  }

  return startChannel.runStores(ctx, () => {
    try {
      const promise = handler(ctx)

      // promise should only reject when propagateError is true:
      // https://github.com/vercel/next.js/blob/cee656238a/packages/next/server/api-utils/node.ts#L547
      promise.then(
        result => finish(ctx, result),
        err => finish(ctx, null, err)
      )
      return promise
    } catch (e) {
      // this will probably never happen as the handler caller is an async function:
      // https://github.com/vercel/next.js/blob/cee656238a/packages/next/server/api-utils/node.ts#L420
      finish(ctx, null, e)
      throw e
    }
  })
}

function wrapServeStatic (serveStatic) {
  return function (req, res, path) {
    return instrument(req, res, () => {
      if (pageLoadChannel.hasSubscribers && path) {
        pageLoadChannel.publish({ page: path, isStatic: true })
      }

      return serveStatic.apply(this, arguments)
    })
  }
}

function finish (ctx, result, err) {
  if (err) {
    ctx.error = err
    errorChannel.publish(ctx)
  }

  const maybeNextRequest = nodeNextRequestsToNextRequests.get(ctx.req)
  if (maybeNextRequest) {
    ctx.nextRequest = maybeNextRequest
  }

  finishChannel.publish(ctx)
}

// also wrapped in dist/server/future/route-handlers/app-route-route-handler.js
// in versions below 13.3.0 that support middleware,
// however, it is not provided as a class function or exported property
addHook({
  name: 'next',
  versions: ['>=13.3.0'],
  file: 'dist/server/web/spec-extension/adapters/next-request.js',
}, NextRequestAdapter => {
  shimmer.wrap(NextRequestAdapter.NextRequestAdapter, 'fromNodeNextRequest', fromNodeNextRequest => {
    return function (nodeNextRequest) {
      const nextRequest = fromNodeNextRequest.apply(this, arguments)
      nodeNextRequestsToNextRequests.set(nodeNextRequest.originalRequest, nextRequest)
      return nextRequest
    }
  })
  return NextRequestAdapter
})

// From Next 15.4.1, route modules execute through precompiled runtime bundles that bypass the
// classic server hooks above. Match bundler and experimental filename variants without enumerating
// them so App Routes, Pages APIs, and App Pages reuse the existing Next request lifecycle.
const APP_ROUTE_RUNTIME_FILE_PATTERN =
  String.raw`dist/compiled/next-server/app-route[\w-]*\.runtime\.(?:dev|prod)\.js$`
const PAGES_API_RUNTIME_FILE_PATTERN =
  String.raw`dist/compiled/next-server/pages-api[\w-]*\.runtime\.(?:dev|prod)\.js$`
const APP_PAGE_RUNTIME_FILE_PATTERN =
  String.raw`dist/compiled/next-server/app-page[\w-]*\.runtime\.(?:dev|prod)\.js$`

const patchedAppRouteModules = new WeakSet()
const patchedPagesApiModules = new WeakSet()
const patchedAppPageModules = new WeakSet()

function wrapOnRequestError (onRequestError) {
  return function (req, error) {
    if (error) {
      errorChannel.publish({ error })
    }
    return onRequestError.apply(this, arguments)
  }
}

function getRoutePage (routeModule, fallbackPage) {
  const definition = routeModule?.definition
  if (typeof definition?.pathname === 'string') {
    return { page: definition.pathname, isFilesystemPath: false }
  }

  if (typeof definition?.page === 'string') {
    return { page: definition.page, isFilesystemPath: true }
  }

  return { page: fallbackPage, isFilesystemPath: false }
}

function wrapAppRouteHandle (handle) {
  return function (req, context) {
    const res = { statusCode: 500 }
    nodeNextRequestsToNextRequests.set(req, req)

    return instrument(req, res, ctx => {
      const pageData = getRoutePage(this)
      if (ctx && pageLoadChannel.hasSubscribers && pageData.page) {
        pageLoadChannel.publish({ ...pageData, isAppPath: true })
      }

      return handle.apply(this, arguments).then(response => {
        if (ctx) ctx.res.statusCode = response?.status || 200
        return response
      })
    })
  }
}

function instrumentAppRouteRuntime (runtime) {
  const AppRouteRouteModule = runtime.AppRouteRouteModule
  const proto = AppRouteRouteModule?.prototype
  if (proto && !patchedAppRouteModules.has(AppRouteRouteModule)) {
    patchedAppRouteModules.add(AppRouteRouteModule)
    if (typeof proto.handle === 'function') {
      shimmer.wrap(proto, 'handle', wrapAppRouteHandle)
    }
    if (typeof proto.onRequestError === 'function') {
      shimmer.wrap(proto, 'onRequestError', wrapOnRequestError)
    }
  }
  return runtime
}

function wrapPagesApiRender (render) {
  return function (req, res, context = {}) {
    return instrument(req, res, ctx => {
      const pageData = getRoutePage(this, context.page)
      if (ctx && pageLoadChannel.hasSubscribers && pageData.page) {
        pageLoadChannel.publish(pageData)
      }

      return render.apply(this, arguments)
    })
  }
}

function instrumentPagesApiRuntime (runtime) {
  const PagesAPIRouteModule = runtime.PagesAPIRouteModule || runtime.default
  const proto = PagesAPIRouteModule?.prototype
  if (proto && !patchedPagesApiModules.has(PagesAPIRouteModule)) {
    patchedPagesApiModules.add(PagesAPIRouteModule)
    if (typeof proto.render === 'function') {
      shimmer.wrap(proto, 'render', wrapPagesApiRender)
    }
  }
  return runtime
}

function wrapAppPageRender (render) {
  return function (req, res, context = {}) {
    return instrument(req, res, ctx => {
      const pageData = getRoutePage(this, context.page)
      if (ctx && pageLoadChannel.hasSubscribers && pageData.page) {
        pageLoadChannel.publish({ ...pageData, isAppPath: true })
      }

      return render.apply(this, arguments).then(result => {
        const statusCode = result?.metadata?.statusCode
        if (ctx && typeof statusCode === 'number') {
          ctx.res.statusCode = statusCode
        }

        return result
      }, error => {
        if (ctx && (typeof ctx.res.statusCode !== 'number' || ctx.res.statusCode < 400)) {
          ctx.res.statusCode = 500
        }

        throw error
      })
    })
  }
}

function instrumentAppPageRuntime (runtime) {
  const AppPageRouteModule = runtime.AppPageRouteModule || runtime.default
  const proto = AppPageRouteModule?.prototype
  if (proto && !patchedAppPageModules.has(AppPageRouteModule)) {
    patchedAppPageModules.add(AppPageRouteModule)
    if (typeof proto.render === 'function') {
      shimmer.wrap(proto, 'render', wrapAppPageRender)
    }
    if (typeof proto.onRequestError === 'function') {
      shimmer.wrap(proto, 'onRequestError', wrapOnRequestError)
    }
  }
  return runtime
}

addHook({
  name: 'next',
  versions: ['>=15.4.1'],
  filePattern: APP_ROUTE_RUNTIME_FILE_PATTERN,
}, instrumentAppRouteRuntime)

addHook({
  name: 'next',
  versions: ['>=15.4.1'],
  filePattern: PAGES_API_RUNTIME_FILE_PATTERN,
}, instrumentPagesApiRuntime)

addHook({
  name: 'next',
  versions: ['>=15.4.1'],
  filePattern: APP_PAGE_RUNTIME_FILE_PATTERN,
}, instrumentAppPageRuntime)

addHook({
  name: 'next',
  versions: ['>=11.1'],
  file: 'dist/server/serve-static.js',
}, serveStatic => shimmer.wrap(serveStatic, 'serveStatic', wrapServeStatic, { replaceGetter: true }))

addHook({
  name: 'next',
  versions: ['>=10.2 <11.1'],
  file: 'dist/next-server/server/serve-static.js',
}, serveStatic => shimmer.wrap(serveStatic, 'serveStatic', wrapServeStatic, { replaceGetter: true }))

addHook({ name: 'next', versions: ['>=11.1'], file: 'dist/server/next-server.js' }, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)

  // Wrapping these makes sure any public API render methods called in a custom server
  // are traced properly
  // (instead of wrapping the top-level API methods, just wrapping these covers them all)
  shimmer.wrap(Server.prototype, 'renderToResponse', wrapRenderToResponse)
  shimmer.wrap(Server.prototype, 'renderErrorToResponse', wrapRenderErrorToResponse)

  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})

// `handleApiRequest` changes parameters/implementation at 13.2.0
addHook({ name: 'next', versions: ['>=13.2'], file: 'dist/server/next-server.js' }, nextServer => {
  const Server = nextServer.default
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequestWithMatch)
  return nextServer
})

addHook({
  name: 'next',
  versions: ['>=11.1 <13.2'],
  file: 'dist/server/next-server.js',
}, nextServer => {
  const Server = nextServer.default
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequest)
  return nextServer
})

addHook({
  name: 'next',
  versions: ['>=10.2 <11.1'],
  file: 'dist/next-server/server/next-server.js',
}, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequest)

  // Likewise with newer versions, these correlate to public API render methods for custom servers
  // all public ones use these methods somewhere in their code path
  shimmer.wrap(Server.prototype, 'renderToHTML', wrapRenderToHTML)
  shimmer.wrap(Server.prototype, 'renderErrorToHTML', wrapRenderErrorToHTML)

  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})

addHook({
  name: 'next',
  versions: ['>=13'],
  file: 'dist/server/web/spec-extension/request.js',
}, request => {
  const requestProto = Object.getPrototypeOf(request.NextRequest.prototype)

  shimmer.massWrap(requestProto, ['text', 'json'], function (originalMethod) {
    return async function wrappedJson () {
      const body = await originalMethod.apply(this, arguments)

      bodyParsedChannel.publish({ body })

      return body
    }
  })

  shimmer.wrap(requestProto, 'formData', function (originalFormData) {
    return async function wrappedFormData () {
      const body = await originalFormData.apply(this, arguments)

      let normalizedBody = body
      if (typeof body.entries === 'function') {
        normalizedBody = Object.fromEntries(body.entries())
      }
      bodyParsedChannel.publish({ body: normalizedBody })

      return body
    }
  })

  return request
})
