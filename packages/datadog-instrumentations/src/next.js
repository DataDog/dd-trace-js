'use strict'

// TODO: either instrument all or none of the render functions

const { channel, addHook, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startChannel = channel('apm:next:request:start')
const finishChannel = channel('apm:next:request:finish')
const errorChannel = channel('apm:next:request:error')
const pageLoadChannel = channel('apm:next:page:load')

const requestResources = new WeakMap()

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

        const page = getPageFromPath(pathname, this.dynamicRoutes)

        pageLoadChannel.publish({ page })

        return handled
      })
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
      pageLoadChannel.publish({ page: getPagePath(pathname) })
    }

    return result
  }
}

function getPagePath (page) {
  return typeof page === 'object' ? page.pathname : page
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
  if (requestResources.has(req)) return handler()

  const requestResource = new AsyncResource('bound-anonymous-fn')

  requestResources.set(req, requestResource)

  return requestResource.runInAsyncScope(() => {
    startChannel.publish({ req, res })

    try {
      const promise = handler()

      // promise should only reject when propagateError is true:
      // https://github.com/vercel/next.js/blob/cee656238a175b8bb75434c013c79279e546381c/packages/next/server/api-utils/node.ts#L547
      return promise.then(
        result => finish(req, res, result),
        err => finish(req, res, null, err)
      )
    } catch (e) {
      // this will probably never happen as the handler caller is an async function:
      // https://github.com/vercel/next.js/blob/cee656238a175b8bb75434c013c79279e546381c/packages/next/server/api-utils/node.ts#L420
      return finish(req, res, null, e)
    }
  })
}

function finish (req, res, result, err) {
  if (err) {
    errorChannel.publish(err)
  }

  finishChannel.publish({ req, res })

  if (err) {
    throw err
  }

  return result
}

addHook({ name: 'next', versions: ['>=11.1'], file: 'dist/server/next-server.js' }, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequest)
  shimmer.wrap(Server.prototype, 'renderToResponse', wrapRenderToResponse)
  shimmer.wrap(Server.prototype, 'renderErrorToResponse', wrapRenderErrorToResponse)
  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})

addHook({ name: 'next', versions: ['>=9.5 <11.1'], file: 'dist/next-server/server/next-server.js' }, nextServer => {
  const Server = nextServer.default

  shimmer.wrap(Server.prototype, 'handleRequest', wrapHandleRequest)
  shimmer.wrap(Server.prototype, 'handleApiRequest', wrapHandleApiRequest)
  shimmer.wrap(Server.prototype, 'renderToHTML', wrapRenderToHTML)
  shimmer.wrap(Server.prototype, 'renderErrorToHTML', wrapRenderErrorToHTML)
  shimmer.wrap(Server.prototype, 'findPageComponents', wrapFindPageComponents)

  return nextServer
})
