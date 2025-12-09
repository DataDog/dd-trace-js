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
// TODO: Add a error channel / handle error events properly.

const eventHandlerMap = new WeakMap()

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

    const ctx = { data, socket: this._sender?._socket }

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
  return shimmer.wrapFunction(handler, originalHandler => function (data, binary) {
    const byteLength = dataLength(data)

    const ctx = { data, binary, socket: this._sender?._socket, byteLength }

    return receiverCh.traceSync(originalHandler, ctx, this, data, binary)
  })
}

function wrapListener (originalOn) {
  return function (eventName, handler) {
    if (eventName === 'message') {
      // Prevent multiple wrapping of the same handler in case the user adds the listener multiple times
      const wrappedHandler = eventHandlerMap.get(handler) ?? createWrappedHandler(handler)
      eventHandlerMap.set(handler, wrappedHandler)
      return originalOn.call(this, eventName, wrappedHandler)
    }
    return originalOn.apply(this, arguments)
  }
}

function removeListener (originalOff) {
  return function (eventName, handler) {
    if (eventName === 'message') {
      const wrappedHandler = eventHandlerMap.get(handler)
      return originalOff.call(this, eventName, wrappedHandler)
    }
    return originalOff.apply(this, arguments)
  }
}

function wrapClose (close) {
  return function (code, data) {
    // _closeFrameReceived is set to true when receiver receives a close frame from a peer
    // _closeFrameSent is set to true when a close frame is sent
    // in the case that a close frame is received and not yet sent then connection is closed by peer
    // if both are true then the self is sending the close event
    const isPeerClose = this._closeFrameReceived === true && this._closeFrameSent === false

    const ctx = { code, data, socket: this._sender?._socket, isPeerClose }

    return closeCh.traceSync(close, ctx, this, ...arguments)
  }
}

addHook({
  name: 'ws',
  file: 'lib/websocket-server.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'handleUpgrade', wrapHandleUpgrade)
  shimmer.wrap(ws.prototype, 'emit', createWrapEmit)
  return ws
})

addHook({
  name: 'ws',
  file: 'lib/websocket.js',
  versions: ['>=8.0.0']
}, ws => {
  shimmer.wrap(ws.prototype, 'send', wrapSend)
  shimmer.wrap(ws.prototype, 'close', wrapClose)

  // TODO: Do not wrap these methods. Instead, add a listener to the websocket instance when one is created.
  // That way it avoids producing too many spans for the same websocket instance and less user code is impacted.
  shimmer.wrap(ws.prototype, 'on', wrapListener)
  shimmer.wrap(ws.prototype, 'addListener', wrapListener)
  shimmer.wrap(ws.prototype, 'off', removeListener)
  shimmer.wrap(ws.prototype, 'removeListener', removeListener)

  return ws
})

function dataLength (data) {
  if (typeof data === 'string') {
    return Buffer.byteLength(data)
  }
  if (data instanceof Blob) {
    return data.size
  }
  return data?.length ?? 0
}
