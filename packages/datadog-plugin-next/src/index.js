'use strict'

// TODO: either instrument all or none of the render functions

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const contexts = new WeakMap()

function createWrapHandleRequest (tracer, config) {
  return function wrapHandleRequest (handleRequest) {
    return function handleRequestWithTrace (req, res, pathname, query) {
      return trace(tracer, config, req, res, () => handleRequest.apply(this, arguments))
    }
  }
}

function createWrapHandleApiRequest (tracer, config) {
  return function wrapHandleApiRequest (handleApiRequest) {
    return function handleApiRequestWithTrace (req, res, pathname, query) {
      return trace(tracer, config, req, res, () => {
        const promise = handleApiRequest.apply(this, arguments)

        return promise.then(handled => {
          if (!handled) return handled

          const page = getPageFromPath(pathname, this.dynamicRoutes)

          addPage(req, page)

          return handled
        })
      })
    }
  }
}

function createWrapRenderToResponse (tracer, config) {
  return function wrapRenderToResponse (renderToResponse) {
    return function renderToResponseWithTrace (ctx) {
      return trace(tracer, config, ctx.req, ctx.res, () => renderToResponse.apply(this, arguments))
    }
  }
}

function createWrapRenderErrorToResponse (tracer, config) {
  return function wrapRenderErrorToResponse (renderErrorToResponse) {
    return function renderErrorToResponseWithTrace (ctx) {
      return trace(tracer, config, ctx.req, ctx.res, () => renderErrorToResponse.apply(this, arguments))
    }
  }
}

function createWrapRenderToHTML (tracer, config) {
  return function wrapRenderToHTML (renderToHTML) {
    return function renderToHTMLWithTrace (req, res, pathname, query, parsedUrl) {
      return trace(tracer, config, req, res, () => renderToHTML.apply(this, arguments))
    }
  }
}

function createWrapRenderErrorToHTML (tracer, config) {
  return function wrapRenderErrorToHTML (renderErrorToHTML) {
    return function renderErrorToHTMLWithTrace (err, req, res, pathname, query) {
      return trace(tracer, config, req, res, () => renderErrorToHTML.apply(this, arguments))
    }
  }
}

function createWrapFindPageComponents (tracer, config) {
  return function wrapFindPageComponents (findPageComponents) {
    return function findPageComponentsWithTrace (pathname, query) {
      const result = findPageComponents.apply(this, arguments)
      const span = tracer.scope().active()
      const req = span && span._nextReq

      if (result) {
        addPage(req, pathname)
      }

      return result
    }
  }
}

function getPageFromPath (page, dynamicRoutes = []) {
  for (const dynamicRoute of dynamicRoutes) {
    if (dynamicRoute.page.startsWith('/api') && dynamicRoute.match(page)) {
      return dynamicRoute.page
    }
  }

  return page
}

function trace (tracer, config, req, res, handler) {
  const scope = tracer.scope()
  const context = contexts.get(req)

  if (context) return scope.activate(context.span, handler)

  const childOf = scope.active()
  const tags = {
    'service.name': config.service || tracer._service,
    'resource.name': req.method,
    'span.type': 'web',
    'span.kind': 'server',
    'http.method': req.method
  }
  const span = tracer.startSpan('next.request', { childOf, tags })

  analyticsSampler.sample(span, config.measured, true)

  contexts.set(req, { span })

  const promise = scope.activate(span, handler)

  // HACK: Store the request object on the span for findPageComponents.
  // TODO: Use CLS when it will be available in core.
  span._nextReq = req

  return promise.then(
    result => finish(span, config, req, res, result),
    err => finish(span, config, req, res, null, err)
  )
}

function addPage (req, page) {
  const context = contexts.get(req)

  if (!context) return

  context.span.addTags({
    'resource.name': `${req.method} ${page}`.trim(),
    'next.page': page
  })
}

function finish (span, config, req, res, result, err) {
  span.setTag('error', err || !config.validateStatus(res.statusCode))
  span.addTags({
    'http.status_code': res.statusCode
  })
  config.hooks.request(span, req, res)
  span.finish()

  return result || err
}

function normalizeConfig (config) {
  const hooks = getHooks(config)
  const validateStatus = typeof config.validateStatus === 'function'
    ? config.validateStatus
    : code => code < 500

  return Object.assign({}, config, { hooks, validateStatus })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = [
  {
    name: 'next',
    versions: ['>=9.5 <11.1'],
    file: 'dist/next-server/server/next-server.js',
    patch ({ default: Server }, tracer, config) {
      config = normalizeConfig(config)

      this.wrap(Server.prototype, 'handleRequest', createWrapHandleRequest(tracer, config))
      this.wrap(Server.prototype, 'handleApiRequest', createWrapHandleApiRequest(tracer, config))
      this.wrap(Server.prototype, 'renderToHTML', createWrapRenderToHTML(tracer, config))
      this.wrap(Server.prototype, 'renderErrorToHTML', createWrapRenderErrorToHTML(tracer, config))
      this.wrap(Server.prototype, 'findPageComponents', createWrapFindPageComponents(tracer, config))
    },
    unpatch ({ default: Server }) {
      this.unwrap(Server.prototype, 'handleRequest')
      this.unwrap(Server.prototype, 'handleApiRequest')
      this.unwrap(Server.prototype, 'renderToHTML')
      this.unwrap(Server.prototype, 'renderErrorToHTML')
      this.unwrap(Server.prototype, 'findPageComponents')
    }
  },

  {
    name: 'next',
    versions: ['>=11.1'],
    file: 'dist/server/next-server.js',
    patch ({ default: Server }, tracer, config) {
      config = normalizeConfig(config)

      this.wrap(Server.prototype, 'handleRequest', createWrapHandleRequest(tracer, config))
      this.wrap(Server.prototype, 'handleApiRequest', createWrapHandleApiRequest(tracer, config))
      this.wrap(Server.prototype, 'renderToResponse', createWrapRenderToResponse(tracer, config))
      this.wrap(Server.prototype, 'renderErrorToResponse', createWrapRenderErrorToResponse(tracer, config))
      this.wrap(Server.prototype, 'findPageComponents', createWrapFindPageComponents(tracer, config))
    },
    unpatch ({ default: Server }) {
      this.unwrap(Server.prototype, 'handleRequest')
      this.unwrap(Server.prototype, 'handleApiRequest')
      this.unwrap(Server.prototype, 'renderToResponse')
      this.unwrap(Server.prototype, 'renderErrorToResponse')
      this.unwrap(Server.prototype, 'findPageComponents')
    }
  }
]
