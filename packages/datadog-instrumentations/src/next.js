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
  return function handleRequestWithTrace (req, res, pathname, query) {
    return instrument(req, res, () => handleRequest.apply(this, arguments))
  }
}

function wrapHandleApiRequest (handleApiRequest) {
  return function handleApiRequestWithTrace (req, res, pathname, query) {
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
  return function renderToResponseWithTrace (ctx) {
    return instrument(ctx.req, ctx.res, () => renderToResponse.apply(this, arguments))
  }
}

function wrapRenderErrorToResponse (renderErrorToResponse) {
  return function renderErrorToResponseWithTrace (ctx) {
    return instrument(ctx.req, ctx.res, () => renderErrorToResponse.apply(this, arguments))
  }
}

function wrapRenderToHTML (renderToHTML) {
  return function renderToHTMLWithTrace (req, res, pathname, query, parsedUrl) {
    return instrument(req, res, () => renderToHTML.apply(this, arguments))
  }
}

function wrapRenderErrorToHTML (renderErrorToHTML) {
  return function renderErrorToHTMLWithTrace (err, req, res, pathname, query) {
    return instrument(req, res, () => renderErrorToHTML.apply(this, arguments))
  }
}

function wrapFindPageComponents (findPageComponents) {
  return function findPageComponentsWithTrace (pathname, query) {
    const result = findPageComponents.apply(this, arguments)

    if (result) {
      pageLoadChannel.publish({ page: pathname })
    }

    return result
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

function instrument (req, res, handler) {
  if (requestResources.has(req)) return handler()

  const requestResource = new AsyncResource('bound-anonymous-fn')

  requestResources.set(req, requestResource)

  return requestResource.runInAsyncScope(() => {
    startChannel.publish({ req, res })

    try {
      const promise = handler()

      return promise.then(
        result => finish(req, res, result),
        err => finish(req, res, null, err)
      )
    } catch (e) {
      finish(req, res, null, e)
    }
  })
}

function finish (req, res, result, err) {
  if (err) {
    errorChannel.publish(err)
  }

  finishChannel.publish({ req, res })

  return result || err
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
