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
const backgroundRevalidationChannel = channel('apm:next:request:background-revalidation')

/**
 * @typedef {import('node:http').IncomingMessage & {
 *   error?: unknown,
 *   originalRequest?: import('node:http').IncomingMessage
 * }} NextNodeRequest
 *
 * @typedef {import('node:http').ServerResponse & {
 *   originalResponse?: import('node:http').ServerResponse
 * }} NextNodeResponse
 *
 * @typedef {object} NextRequest
 * @property {unknown} [error]
 *
 * @typedef {object} NextRequestContext
 * @property {NextNodeRequest} req
 * @property {NextNodeResponse} res
 * @property {boolean} [finishOnResponse]
 * @property {boolean} [handlerFinished]
 * @property {boolean} [responseFinished]
 * @property {unknown} [error]
 * @property {NextRequest} [nextRequest]
 *
 * @typedef {object} ResponseGeneratorContext
 * @property {boolean} [hasResolved]
 *
 * @typedef {object} HandleResponseOptions
 * @property {NextNodeRequest} req
 * @property {(context?: ResponseGeneratorContext) => Promise<unknown>} responseGenerator
 *
 * @typedef {object} ResponseCacheEntry
 * @property {{ status?: number }} [value]
 */

const requests = new WeakSet()
const nodeNextRequestsToNextRequests = new WeakMap()
const requestErrors = new WeakMap()
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

/**
 * @template T
 * @param {NextNodeRequest} req
 * @param {NextNodeResponse} res
 * @param {(ctx: NextRequestContext) => Promise<T>} handler
 * @param {unknown} [error]
 * @param {boolean} [finishOnResponse]
 * @returns {Promise<T>}
 */
function instrument (req, res, handler, error, finishOnResponse = false) {
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

  const ctx = finishOnResponse ? { req, res, finishOnResponse } : { req, res }
  if (finishOnResponse) {
    const onResponseFinish = () => {
      res.removeListener('finish', onResponseFinish)
      res.removeListener('close', onResponseFinish)
      ctx.responseFinished = true
      if (ctx.handlerFinished) publishFinish(ctx, ctx.error)
    }
    res.once('finish', onResponseFinish)
    res.once('close', onResponseFinish)
  }
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

function publishFinish (ctx, error) {
  publishError(ctx.req, ctx, error)
  requestErrors.delete(ctx.req)

  const maybeNextRequest = nodeNextRequestsToNextRequests.get(ctx.req)
  if (maybeNextRequest) {
    ctx.nextRequest = maybeNextRequest
  }

  finishChannel.publish(ctx)
}

function finish (ctx, result, error) {
  if (ctx.finishOnResponse) {
    ctx.handlerFinished = true
    if (error) ctx.error = error
    if (!ctx.responseFinished) return
  }

  publishFinish(ctx, error)
}

/**
 * @param {NextNodeRequest} req
 * @param {NextRequestContext | undefined} ctx
 * @param {unknown} error
 */
function publishError (req, ctx, error) {
  if (!error) return

  req = req.originalRequest || req
  let errors = requestErrors.get(req)
  if (errors?.has(error)) return

  if (!errors) {
    errors = new Set()
    requestErrors.set(req, errors)
  }
  errors.add(error)

  if (ctx) {
    ctx.error = error
    errorChannel.publish(ctx)
  } else {
    errorChannel.publish({ req, error })
  }
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
// The route module classes and inherited methods are selected inside those bundles, so there is no
// stable source function for Orchestrion to rewrite.
const patchedRouteModules = new WeakSet()
const routeResponses = new WeakMap()
const activeRouteRequests = new WeakMap()
const COMPILED_RUNTIME_PATH = 'dist/compiled/next-server/'
function wrapOnRequestError (onRequestError) {
  return function (req, error) {
    if (error) publishError(req, undefined, error)
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

function publishRoutePage (ctx, routeModule, fallbackPage, isAppPath) {
  if (!ctx || !pageLoadChannel.hasSubscribers) return

  const pageData = getRoutePage(routeModule, fallbackPage)
  if (pageData.page) {
    pageLoadChannel.publish(isAppPath ? { ...pageData, isAppPath: true } : pageData)
  }
}

function wrapAppRouteHandle (handle) {
  return function (req, context) {
    if (finishChannel.hasSubscribers) {
      const nodeRequest = activeRouteRequests.get(this)
      if (nodeRequest) {
        nodeNextRequestsToNextRequests.set(nodeRequest, req)
      }
    }

    return handle.apply(this, arguments)
  }
}

function wrapPrepare (prepare) {
  return function (req, res) {
    if (startChannel.hasSubscribers || queryParsedChannel.hasSubscribers) {
      routeResponses.set(req, res)
    }

    return prepare.apply(this, arguments)
  }
}

/**
 * @param {(context?: ResponseGeneratorContext) => unknown} responseGenerator
 * @param {object | undefined} routeModule
 * @param {NextNodeRequest} req
 * @returns {(context?: ResponseGeneratorContext) => unknown}
 */
function wrapResponseGenerator (responseGenerator, routeModule, req) {
  return function (context) {
    if (context?.hasResolved) {
      const nodeRequest = req.originalRequest || req
      return backgroundRevalidationChannel.runStores(nodeRequest, () => responseGenerator.apply(this, arguments))
    }
    if (!routeModule) {
      return responseGenerator.apply(this, arguments)
    }

    // Next calls the route module before the generator's first await. Limit the association to that
    // synchronous call so concurrent requests can share the route module instance safely.
    activeRouteRequests.set(routeModule, req)
    try {
      return responseGenerator.apply(this, arguments)
    } finally {
      activeRouteRequests.delete(routeModule)
    }
  }
}

/**
 * @param {(options: HandleResponseOptions) => Promise<ResponseCacheEntry | undefined>} handleResponse
 * @param {boolean} associateNextRequest
 * @returns {(options: HandleResponseOptions) => Promise<ResponseCacheEntry | undefined>}
 */
function wrapHandleResponse (handleResponse, associateNextRequest) {
  return function (options) {
    const req = options.req
    const res = routeResponses.get(req)
    routeResponses.delete(req)

    if (!res || (!startChannel.hasSubscribers && !queryParsedChannel.hasSubscribers)) {
      return handleResponse.apply(this, arguments)
    }

    const routeModule = associateNextRequest ? this : undefined
    options.responseGenerator = wrapResponseGenerator(options.responseGenerator, routeModule, req)

    return instrument(req, res, ctx => {
      publishRoutePage(ctx, this, undefined, true)

      return handleResponse.apply(this, arguments).then(result => {
        const statusCode = result?.value?.status
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
    }, undefined, finishChannel.hasSubscribers)
  }
}

/**
 * @param {(options: HandleResponseOptions) => Promise<ResponseCacheEntry | undefined>} handleResponse
 * @returns {(options: HandleResponseOptions) => Promise<ResponseCacheEntry | undefined>}
 */
function wrapAppRouteHandleResponse (handleResponse) {
  return wrapHandleResponse(handleResponse, true)
}

/**
 * @param {(options: HandleResponseOptions) => Promise<ResponseCacheEntry | undefined>} handleResponse
 * @returns {(options: HandleResponseOptions) => Promise<ResponseCacheEntry | undefined>}
 */
function wrapAppPageHandleResponse (handleResponse) {
  return wrapHandleResponse(handleResponse, false)
}

function instrumentRouteModule (RouteModule, wrappers, handleErrors) {
  const proto = RouteModule?.prototype
  if (!proto || patchedRouteModules.has(RouteModule)) return

  patchedRouteModules.add(RouteModule)
  for (const [method, wrapper] of wrappers) {
    if (typeof proto[method] === 'function') {
      shimmer.wrap(proto, method, wrapper)
    }
  }
  if (handleErrors && typeof proto.onRequestError === 'function') {
    shimmer.wrap(proto, 'onRequestError', wrapOnRequestError)
  }
}

function instrumentAppRouteRuntime (runtime) {
  instrumentRouteModule(runtime.AppRouteRouteModule, [
    ['prepare', wrapPrepare],
    ['handleResponse', wrapAppRouteHandleResponse],
    ['handle', wrapAppRouteHandle],
  ], true)
  return runtime
}

function wrapPagesApiRender (render) {
  return function (req, res, context = {}) {
    if (!startChannel.hasSubscribers && !queryParsedChannel.hasSubscribers) {
      return render.apply(this, arguments)
    }

    return instrument(req, res, ctx => {
      publishRoutePage(ctx, this, context.page, false)

      const { onError } = context
      return render.call(this, req, res, {
        ...context,
        onError: function (error) {
          publishError(req, ctx, error)
          return onError?.apply(this, arguments)
        },
      })
    })
  }
}

function instrumentPagesApiRuntime (runtime) {
  const PagesAPIRouteModule = runtime.PagesAPIRouteModule || runtime.default
  instrumentRouteModule(PagesAPIRouteModule, [['render', wrapPagesApiRender]], false)
  return runtime
}

function instrumentAppPageRuntime (runtime) {
  const AppPageRouteModule = runtime.AppPageRouteModule || runtime.default
  instrumentRouteModule(AppPageRouteModule, [
    ['prepare', wrapPrepare],
    ['handleResponse', wrapAppPageHandleResponse],
  ], true)
  return runtime
}

for (const [runtime, instrumentRuntime] of [
  ['app-route', instrumentAppRouteRuntime],
  ['pages-api', instrumentPagesApiRuntime],
  ['app-page', instrumentAppPageRuntime],
]) {
  addHook({
    name: 'next',
    versions: ['>=15.4.1'],
    filePattern: String.raw`${COMPILED_RUNTIME_PATH}${runtime}[\w-]*\.runtime\.(?:dev|prod)\.js$`,
  }, instrumentRuntime)
}

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
