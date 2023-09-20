'use strict'

// TODO: either instrument all or none of the render functions

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { DD_MAJOR } = require('../../../version')

const startChannel = channel('apm:next:request:start')
const finishChannel = channel('apm:next:request:finish')
const errorChannel = channel('apm:next:request:error')
const pageLoadChannel = channel('apm:next:page:load')

const requests = new WeakSet()

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
      const page = (typeof match === 'object' && typeof match.definition === 'object')
        ? match.definition.pathname
        : undefined

      pageLoadChannel.publish({ page })

      return handleApiRequest.apply(this, arguments)
    })
  }
}

function wrapRenderToResponse (renderToResponse) {
  return function (ctx) {
    return instrument(ctx.req, ctx.res, () => renderToResponse.apply(this, arguments))
  }
}

function wrapRenderErrorToResponse (renderErrorToResponse) {
  return function (ctx) {
    return instrument(ctx.req, ctx.res, () => renderErrorToResponse.apply(this, arguments))
  }
}

function wrapRenderToHTML (renderToHTML) {
  return function (req, res, pathname, query, parsedUrl) {
    return instrument(req, res, () => renderToHTML.apply(this, arguments))
  }
}

function wrapRenderErrorToHTML (renderErrorToHTML) {
  return function (err, req, res, pathname, query) {
    return instrument(req, res, () => renderErrorToHTML.apply(this, arguments))
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
    if (dynamicRoute.page.startsWith('/api') && dynamicRoute.match(page)) {
      return getPagePath(dynamicRoute.page)
    }
  }

  return getPagePath(page)
}

function instrument (req, res, handler) {
  req = req.originalRequest || req
  res = res.originalResponse || res

  if (requests.has(req)) return handler()

  requests.add(req)

  const ctx = { req, res }

  return startChannel.runStores(ctx, () => {
    try {
      const promise = handler(ctx)

      // promise should only reject when propagateError is true:
      // https://github.com/vercel/next.js/blob/cee656238a/packages/next/server/api-utils/node.ts#L547
      return promise.then(
        result => finish(ctx, result),
        err => finish(ctx, null, err)
      )
    } catch (e) {
      // this will probably never happen as the handler caller is an async function:
      // https://github.com/vercel/next.js/blob/cee656238a/packages/next/server/api-utils/node.ts#L420
      return finish(ctx, null, e)
    }
  })
}

function wrapServeStatic (serveStatic) {
  return function (req, res, path) {
    return instrument(req, res, () => {
      if (pageLoadChannel.hasSubscribers && path) pageLoadChannel.publish({ page: path })

      return serveStatic.apply(this, arguments)
    })
  }
}

function finish (ctx, result, err) {
  if (err) {
    ctx.error = err
    errorChannel.publish(ctx)
  }

  finishChannel.publish(ctx)

  if (err) {
    throw err
  }

  return result
}

addHook({
  name: 'next',
  versions: ['>=11.1'],
  file: 'dist/server/serve-static.js'
}, serveStatic => shimmer.wrap(serveStatic, 'serveStatic', wrapServeStatic))

addHook({
  name: 'next',
  versions: DD_MAJOR >= 4 ? ['>=10.2 <11.1'] : ['>=9.5 <11.1'],
  file: 'dist/next-server/server/serve-static.js'
}, serveStatic => shimmer.wrap(serveStatic, 'serveStatic', wrapServeStatic))

addHook({ name: 'next', versions: ['>=13.2'], file: 'dist/server/next-server.js' }, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequestWithMatch)
  shimmer.wrap(Server.prototype, 'renderToResponse', wrapRenderToResponse)
  shimmer.wrap(Server.prototype, 'renderErrorToResponse', wrapRenderErrorToResponse)
  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})

addHook({ name: 'next', versions: ['>=11.1 <13.2'], file: 'dist/server/next-server.js' }, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequest)
  shimmer.wrap(Server.prototype, 'renderToResponse', wrapRenderToResponse)
  shimmer.wrap(Server.prototype, 'renderErrorToResponse', wrapRenderErrorToResponse)
  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})

addHook({
  name: 'next',
  versions: DD_MAJOR >= 4 ? ['>=10.2 <11.1'] : ['>=9.5 <11.1'],
  file: 'dist/next-server/server/next-server.js'
}, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequest)
  shimmer.wrap(Server.prototype, 'renderToHTML', wrapRenderToHTML)
  shimmer.wrap(Server.prototype, 'renderErrorToHTML', wrapRenderErrorToHTML)
  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})
