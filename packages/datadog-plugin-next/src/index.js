'use strict'

// TODO: either instrument all or none of the render functions

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

        promise.then(handled => {
          if (!handled) return

          const page = getPageFromPath(pathname, this.dynamicRoutes)

          addPage(req, page)
        })

        return promise
      })
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

function createWrapRenderToHTMLWithComponents (tracer, config) {
  return function wrapHandleRenderToHTMLWithComponents (renderToHTMLWithComponents) {
    return function renderToHTMLWithComponentsWithTrace (req, res, page) {
      addPage(req, page)

      return renderToHTMLWithComponents.apply(this, arguments)
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

  if (req._datadog_next) return scope.activate(req._datadog_next.span, handler)

  const childOf = scope.active()
  const tags = {
    'service.name': config.service || `${tracer._service}-next`,
    'resource.name': req.method,
    'span.type': 'web',
    'span.kind': 'server',
    'http.method': req.method
  }
  const span = tracer.startSpan('next.request', { childOf, tags })

  req._datadog_next = { span }

  const promise = scope.activate(span, handler)

  promise.then(() => finish(span, config, req, res), err => {
    span.setTag('error', err)
    finish(span, config, req, res)
  })

  return promise
}

function addPage (req, page) {
  if (!req._datadog_next) return

  req._datadog_next.span.addTags({
    'resource.name': `${req.method} ${page}`.trim(),
    'next.page': page
  })
}

function finish (span, config, req, res) {
  span.addTags({
    'http.status_code': res.statusCode
  })
  config.hooks.request(span, req, res)
  span.finish()
}

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, { hooks })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = [
  {
    name: 'next',
    versions: ['>=9.5'],
    file: 'dist/next-server/server/next-server.js',
    patch ({ default: Server }, tracer, config) {
      config = normalizeConfig(config)

      this.wrap(Server.prototype, 'handleRequest', createWrapHandleRequest(tracer, config))
      this.wrap(Server.prototype, 'handleApiRequest', createWrapHandleApiRequest(tracer, config))
      this.wrap(Server.prototype, 'renderToHTML', createWrapRenderToHTML(tracer, config))
      this.wrap(Server.prototype, 'renderToHTMLWithComponents', createWrapRenderToHTMLWithComponents(tracer, config))
    },
    unpatch ({ default: Server }) {
      this.unwrap(Server.prototype, 'handleRequest')
      this.unwrap(Server.prototype, 'handleApiRequest')
      this.unwrap(Server.prototype, 'renderToHTML')
      this.unwrap(Server.prototype, 'renderToHTMLWithComponents')
    }
  }
]
