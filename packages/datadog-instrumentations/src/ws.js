'use strict'

const {
  addHook,
  channel,
  AsyncResource
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

function wrapHandleUpgrade (handleUpgrade) {
  return function () {
    if (!ch.start.hasSubscribers) return handleUpgrade.apply(this, arguments)

    const [req, socket, head, cb] = arguments
    const ctx = { req }

    return ch.tracePromise(() => {
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
