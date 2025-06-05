'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel
const ch = tracingChannel('ws:client:connect')

function createWrapRequest (ws, options) {
  return function wrapRequest (request) {
    return function (headers) {
      if (!ch.start.hasSubscribers) return request.apply(this, arguments)

      const ctx = { headers, ws, options }

      return ch.tracePromise(() => request.call(this), ctx)
    }
  }
}
function createWrapEmit (ctx) {
  return function wrapEmit (emit) {
    return function (title, headers, req) {
      ctx.resStatus = headers[0].split(' ')[1]

      return ch.asyncStart.runStores(ctx, () => {
        try {
          return emit.apply(this, arguments)
        } finally {
          ch.asyncEnd.publish(ctx)
        }
      })
    }
  }
}

function wrapHandleUpgrade (handleUpgrade) {
  return function () {
    if (!ch.start.hasSubscribers) return handleUpgrade.apply(this, arguments)

    const [req, socket, head, cb] = arguments
    const ctx = { req }

    return ch.tracePromise(() => {
      shimmer.wrap(this, 'emit', createWrapEmit(ctx))
      handleUpgrade.call(this, req, socket, head, cb)
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
