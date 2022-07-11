'use strict'

const shimmer = require('../../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('../helpers/instrument')

const startChannel = channel('apm:http2:client:request:start')
const finishChannel = channel('apm:http2:client:request:finish')
const errorChannel = channel('apm:http2:client:request:error')
const responseChannel = channel('apm:http2:client:response')

function createWrapEmit (requestResource, parentResource) {
  return function wrapEmit (emit) {
    return function emitWithTrace (event, arg1) {
      requestResource.runInAsyncScope(() => {
        switch (event) {
          case 'response':
            responseChannel.publish(arg1)
            break
          case 'error':
            errorChannel.publish(arg1)
          case 'close': // eslint-disable-line no-fallthrough
            finishChannel.publish()
            break
        }
      })

      return parentResource.runInAsyncScope(() => {
        return emit.apply(this, arguments)
      })
    }
  }
}

function createWrapRequest (authority, options) {
  return function wrapRequest (request) {
    return function requestWithTrace (headers) {
      const parentResource = new AsyncResource('bound-anonymous-fn')
      const requestResource = new AsyncResource('bound-anonymous-fn')

      return requestResource.runInAsyncScope(() => {
        startChannel.publish({ headers, authority, options })

        const req = request.apply(this, arguments)

        shimmer.wrap(req, 'emit', createWrapEmit(requestResource, parentResource))

        return req
      })
    }
  }
}

function wrapConnect (connect) {
  return function connectWithTrace (authority, options) {
    const session = connect.apply(this, arguments)

    shimmer.wrap(session, 'request', createWrapRequest(authority, options))

    return session
  }
}

addHook({ name: 'http2' }, http2 => {
  shimmer.wrap(http2, 'connect', wrapConnect)

  return http2
})
