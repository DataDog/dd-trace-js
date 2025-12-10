'use strict'

// WeakMap to store message counters per socket without mutating the socket object
const socketCounters = new WeakMap()

/**
 * Initializes WebSocket message counters for a socket.
 * @param {object} socket - The WebSocket socket object
 */
function initWebSocketMessageCounters (socket) {
  if (!socketCounters.has(socket)) {
    socketCounters.set(socket, {
      receiveCounter: 0,
      sendCounter: 0
    })
  }
}

/**
 * Increments and returns the WebSocket message counter.
 * @param {object} socket - The WebSocket socket object
 * @param {string} counterType - Either 'receiveCounter' or 'sendCounter'
 * @returns {number} The incremented counter value
 */
function incrementWebSocketCounter (socket, counterType) {
  if (!socketCounters.has(socket)) {
    initWebSocketMessageCounters(socket)
  }
  const counters = socketCounters.get(socket)
  counters[counterType]++
  return counters[counterType]
}

/**
 * Builds a WebSocket span pointer hash.
 *
 * Format: <prefix><128 bit hex trace id><64 bit hex span id><32 bit hex counter>
 * Prefix: 'S' for server outgoing or client incoming, 'C' for server incoming or client outgoing
 *
 * @param {string} handshakeTraceId - The trace ID from the handshake span (hex string)
 * @param {string} handshakeSpanId - The span ID from the handshake span (hex string)
 * @param {number} counter - The message counter
 * @param {boolean} isServer - Whether this is a server (true) or client (false)
 * @param {boolean} isIncoming - Whether this is an incoming message (true) or outgoing (false)
 * @returns {string} The span pointer hash
 */
function buildWebSocketSpanPointerHash (handshakeTraceId, handshakeSpanId, counter, isServer, isIncoming) {
  // Determine prefix based on server/client and incoming/outgoing
  // Server outgoing or client incoming: 'S'
  // Server incoming or client outgoing: 'C'
  const prefix = (isServer && !isIncoming) || (!isServer && isIncoming) ? 'S' : 'C'

  // Pad trace ID to 32 hex chars (128 bits)
  const traceIdHex = handshakeTraceId.toString().padStart(32, '0')

  // Pad span ID to 16 hex chars (64 bits)
  const spanIdHex = handshakeSpanId.toString().padStart(16, '0')

  // Pad counter to 8 hex chars (32 bits)
  const counterHex = counter.toString(16).padStart(8, '0')

  return `${prefix}${traceIdHex}${spanIdHex}${counterHex}`
}

/**
 * Checks if the handshake span has extracted distributed tracing context.
 * A websocket server must not set the span pointer if the handshake has not extracted a context.
 *
 * A span has distributed tracing context if it has a parent context that was
 * extracted from headers (remote parent).
 *
 * @param {object} span - The handshake span
 * @returns {boolean} True if the span has distributed tracing context
 */
function hasDistributedTracingContext (span) {
  if (!span) return false
  const context = span.context()
  if (!context) return false

  // Check if this span has a parent. If the parent was extracted from remote headers,
  // then this span is part of a distributed trace.
  // We check if the span has a parent by looking at _parentId.
  // In the JavaScript tracer, when a context is extracted from headers and a child span
  // is created, the child will have _parentId set to the extracted parent's span ID.
  return context._parentId !== null
}

module.exports = {
  initWebSocketMessageCounters,
  incrementWebSocketCounter,
  buildWebSocketSpanPointerHash,
  hasDistributedTracingContext
}
