'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel
const serverCh = tracingChannel('ws:server:connect')
const producerCh = tracingChannel('ws:send')

function createWrapRequest (ws, options) {
  return function wrapRequest (request) {
    return function (headers) {
      if (!serverCh.start.hasSubscribers) return request.apply(this, arguments)

      const ctx = { headers, ws, options }

      return serverCh.tracePromise(() => request.call(this), ctx)
    }
  }
}
function createWrapEmit (ctx) {
  return function wrapEmit (emit) {
    return function (title, headers, req) {
      ctx.resStatus = headers[0].split(' ')[1]

      // return serverCh.tracePromise(() => {
      //   // console.log('ctx in instrumentation', arguments)
      //   return emit.apply(this, arguments)
      // }, ctx)
      serverCh.asyncStart.runStores(ctx, () => {
        try {
          return emit.apply(this, arguments)
        } finally {
          serverCh.asyncEnd.publish(ctx)
        }
      })
    }
  }
}

function wrapHandleUpgrade (handleUpgrade) {
  return function () {
    if (!serverCh.start.hasSubscribers) return handleUpgrade.apply(this, arguments)

    const [req, socket, head, cb] = arguments
    const ctx = { req, socket }

    return serverCh.tracePromise(() => {
      shimmer.wrap(this, 'emit', createWrapEmit(ctx))
      handleUpgrade.call(this, req, socket, head, cb)
    }, ctx)
  }
}

function wrapHandleSend (send) {
  return function wrappedSend (...args) {
    if (!producerCh.start.hasSubscribers) return send.apply(this, arguments)

    const [data, options, cb] = arguments
    const ctx = { data, link: this._sender._socket }

    return producerCh.tracePromise(() => {
      send.call(this, data, options, cb)
    }, ctx)
  }
}

addHook({
  name: 'ws',
  file: 'lib/websocket-server.js'
}, ws => {
  shimmer.wrap(ws.prototype, 'handleUpgrade', wrapHandleUpgrade)

  return ws
})

addHook({
  name: 'ws',
  file: 'lib/websocket.js'
}, ws => {
  shimmer.wrap(ws.prototype, 'send', wrapHandleSend)

  return ws
})
