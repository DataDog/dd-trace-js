'use strict'

const { tracingChannel } = /** @type {import('node:diagnostics_channel')} */ (require('dc-polyfill'))

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
  channel,
} = require('./helpers/instrument')

const serverCh = tracingChannel('ws:server:connect')
const producerCh = tracingChannel('ws:send')
const receiverCh = tracingChannel('ws:receive')
const closeCh = tracingChannel('ws:close')
const emitCh = channel('tracing:ws:server:connect:emit')
const setSocketCh = channel('tracing:ws:server:connect:setSocket')
// TODO: Add a error channel / handle error events properly.

/**
 * @typedef {object} WebSocketServerPrototype
 * @property {(...args: unknown[]) => unknown} handleUpgrade
 * @property {(...args: unknown[]) => unknown} emit
 */

/**
 * @typedef {{ prototype: WebSocketServerPrototype }} WebSocketServerClass
 */

/**
 * @typedef {object} WebSocketPrototype
 * @property {(...args: unknown[]) => unknown} send
 * @property {(...args: unknown[]) => unknown} close
 * @property {(...args: unknown[]) => unknown} setSocket
 */

/**
 * @typedef {{ prototype: WebSocketPrototype }} WebSocketClass
 */

/**
 * @typedef {object} ReceiverPrototype
 * @property {(eventName: string, listener: (...args: unknown[]) => unknown) => unknown} on
 * @property {(eventName: string, listener: (...args: unknown[]) => unknown) => unknown} addListener
 */

/**
 * @typedef {{ prototype: ReceiverPrototype }} ReceiverClass
 */

/**
 * @typedef {string | Buffer | ArrayBuffer | ArrayBufferView | Blob | Buffer[]} WebSocketMessageData
 */

/**
 * @typedef {object} WebSocketInstance
 * @property {(...args: unknown[]) => unknown} emit
 * @property {(eventName: string) => number} [listenerCount]
 * @property {{ _socket?: unknown } | undefined} [_sender]
 * @property {unknown} [_receiver]
 */

let kWebSocketSymbol

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
    if (!producerCh.start.hasSubscribers) {
      return send.apply(this, arguments)
    }

    const [data, options, cb] = arguments

    const ctx = { data, socket: this._sender?._socket }

    return typeof cb === 'function'
      ? producerCh.traceCallback(send, undefined, ctx, this, data, options, cb)
      : producerCh.traceSync(send, ctx, this, data, options, cb)
  }
}

function createWrapEmit (emit) {
  return function (title, headers, req) {
    if (!serverCh.start.hasSubscribers || title !== 'headers') {
      return emit.apply(this, arguments)
    }

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

/**
 * @param {Function} setSocket
 * @returns {(...args: unknown[]) => unknown}
 */
/**
 * @param {Function} on
 * @returns {(...args: unknown[]) => unknown}
 */
function wrapReceiverOn (on) {
  return function wrappedOn (eventName, handler) {
    if (eventName !== 'message' || typeof handler !== 'function') {
      return on.apply(this, arguments)
    }

    const wrappedHandler = function (data, isBinary) {
      if (!receiverCh.start.hasSubscribers || !kWebSocketSymbol) {
        return handler.call(this, data, isBinary)
      }

      const websocket = /** @type {WebSocketInstance | undefined} */ (this[kWebSocketSymbol])
      // Avoid receive spans when no one listens to messages.
      if (websocket && typeof websocket.listenerCount === 'function' && websocket.listenerCount('message') === 0) {
        return handler.call(this, data, isBinary)
      }
      const socket = websocket?._sender?._socket
      if (!socket) {
        return handler.call(this, data, isBinary)
      }

      const byteLength = dataLength(/** @type {WebSocketMessageData} */ (data))
      const ctx = { data, binary: isBinary, socket, byteLength }

      return receiverCh.traceSync(handler, ctx, this, data, isBinary)
    }

    return on.call(this, eventName, wrappedHandler)
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
  versions: ['>=8.0.0'],
}, moduleExports => {
  const ws = /** @type {WebSocketServerClass} */ (moduleExports)
  shimmer.wrap(ws.prototype, 'handleUpgrade', wrapHandleUpgrade)
  shimmer.wrap(ws.prototype, 'emit', createWrapEmit)
  return ws
})

/**
 * Prevent internal event handlers (data, close, etc.) registered by the ws library to
 * capture the connection span in their async context. Otherwise, the
 * finished connection span is retained for the entire lifetime of the WebSocket
 * (via ACF -> handle -> WeakMap).
 *
 * @param {Function} setSocket
 * @returns {(...args: unknown[]) => unknown}
 */
function wrapSetSocket (setSocket) {
  return function wrappedSetSocket (...args) {
    if (!setSocketCh.hasSubscribers) {
      return setSocket.apply(this, args)
    }
    return setSocketCh.runStores({}, () => {
      return setSocket.apply(this, args)
    })
  }
}

addHook({
  name: 'ws',
  file: 'lib/websocket.js',
  versions: ['>=8.0.0'],
}, moduleExports => {
  const ws = /** @type {WebSocketClass} */ (moduleExports)
  shimmer.wrap(ws.prototype, 'setSocket', wrapSetSocket)
  shimmer.wrap(ws.prototype, 'send', wrapSend)
  shimmer.wrap(ws.prototype, 'close', wrapClose)

  return ws
})

addHook({
  name: 'ws',
  file: 'lib/constants.js',
  versions: ['>=8.0.0'],
}, moduleExports => {
  const constants = /** @type {{ kWebSocket?: symbol }} */ (moduleExports)
  kWebSocketSymbol = constants.kWebSocket
  return constants
})

addHook({
  name: 'ws',
  file: 'lib/receiver.js',
  versions: ['>=8.0.0'],
}, moduleExports => {
  const Receiver = /** @type {ReceiverClass} */ (moduleExports)
  shimmer.wrap(Receiver.prototype, 'on', wrapReceiverOn)
  shimmer.wrap(Receiver.prototype, 'addListener', wrapReceiverOn)
  return Receiver
})

/**
 * @param {WebSocketMessageData} data
 * @returns {number}
 */
function dataLength (data) {
  if (typeof data === 'string') {
    return Buffer.byteLength(data)
  }
  if (data instanceof Blob) {
    return data.size
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  let total = 0
  if (Array.isArray(data)) {
    const chunks = /** @type {Buffer[]} */ (data)
    for (const chunk of chunks) {
      total += chunk.length
    }
  }
  return total
}
