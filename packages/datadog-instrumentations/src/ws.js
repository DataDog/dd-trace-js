'use strict'

const {
  addHook,
  channel
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel
const serverCh = tracingChannel('ws:server:connect')
const producerCh = tracingChannel('ws:send')
const receiverCh = tracingChannel('ws:receive')
const closeCh = tracingChannel('ws:close')
const emitCh = channel('tracing:ws:server:connect:emit')

function wrapHandleUpgrade (handleUpgrade) {
  return function () {
    const [req, socket, , cb] = arguments
    if (!serverCh.start.hasSubscribers || typeof cb !== 'function') {
      return handleUpgrade.apply(this, arguments)
    }

    const ctx = { req, socket }

    arguments[3] = function () {
      return serverCh.asyncStart.runStores(ctx, () => {
        try {
          return cb.apply(this, arguments)
        } finally {
          serverCh.asyncEnd.publish(ctx)
        }
      }, this, ...arguments)
    }
    return serverCh.traceSync(handleUpgrade, ctx, this, ...arguments)
  }
}

function wrapSend (send) {
  return function wrappedSend (...args) {
    if (!producerCh.start.hasSubscribers) return send.apply(this, arguments)

    const [data, options, cb] = arguments

    const ctx = { data, socket: this._sender._socket }

    return typeof cb === 'function'
      ? producerCh.traceCallback(send, undefined, ctx, this, data, options, cb)
      : producerCh.traceSync(send, ctx, this, data, options, cb)
  }
}

function createWrapEmit (emit) {
  return function (title, headers, req) {
    if (!serverCh.start.hasSubscribers || title !== 'headers') return emit.apply(this, arguments)

    const ctx = { req }
    ctx.req.resStatus = headers[0].split(' ')[1]

    emitCh.runStores(ctx, () => {
      try {
        return emit.apply(this, arguments)
      } finally {
        emitCh.publish(ctx)
      }
    })
  }
}

function createWrappedHandler (handler) {
  return function wrappedMessageHandler (data, binary) {
    const byteLength = dataLength(data)

    const ctx = { data, binary, socket: this._sender._socket, byteLength }

    return receiverCh.traceSync(handler, ctx, this, data, binary)
  }
}

function wrapListener (originalOn) {
  return function (eventName, handler) {
    if (eventName === 'message') {
      return originalOn.call(this, eventName, createWrappedHandler(handler))
    }
    return originalOn.apply(this, arguments)
  }
}

function wrapClose (close) {
  return function (code, data) {
    const ctx = { code, data, socket: this._sender._socket }
    return closeCh.traceSync(close, ctx, this, ...arguments)
  }
}

addHook({
  name: 'ws',
  file: 'lib/websocket-server.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'handleUpgrade', wrapHandleUpgrade)

  return ws
})

addHook({
  name: 'ws',
  file: 'lib/websocket.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'send', wrapSend)

  return ws
})

addHook({
  name: 'ws',
  file: 'lib/websocket-server.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'emit', createWrapEmit)

  return ws
})

addHook({
  name: 'ws',
  file: 'lib/websocket.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'on', wrapListener)
  return ws
})

addHook({
  name: 'ws',
  file: 'lib/websocket.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'close', wrapClose)
  return ws
})

function detectType (data) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return 'Blob'
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return 'Buffer'
  if (typeof data === 'string') return 'string'
  return 'Unknown'
}

function dataLength (data) {
  const type = detectType(data)
  if (type === 'Blob') return data.size
  if (type === 'Buffer') return data.length
  if (type === 'string') return Buffer.byteLength(data)
  return 0
}
