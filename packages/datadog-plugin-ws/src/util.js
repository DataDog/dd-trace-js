'use strict'

const { readDatadogTraceId, readTraceparent } = require('../../dd-trace/src/carrier')
const id = require('../../dd-trace/src/id')
const DatadogSpanContext = require('../../dd-trace/src/opentracing/span_context')
const TraceState = require('../../dd-trace/src/opentracing/propagation/tracestate')
const { AUTO_KEEP, AUTO_REJECT } = require('../../../ext/priority')

const TRACE_ID_UPPER_TAG = '_dd.p.tid'

// WeakMap to store message counters per socket without mutating the socket object
const socketCounters = new WeakMap()

/**
 * Creates a minimal span context for span links without retaining the full trace.
 * @param {DatadogSpanContext} spanContext
 * @returns {DatadogSpanContext | undefined}
 */
function createWebSocketSpanContext (spanContext) {
  if (!spanContext) return

  const [version, traceId, spanId, flags] = spanContext.toTraceparent().split('-')
  const traceIdUpper = traceId.slice(0, 16)
  const trace = traceIdUpper &&
    traceIdUpper !== '0000000000000000'
    ? { started: [], finished: [], tags: { [TRACE_ID_UPPER_TAG]: traceIdUpper } }
    : undefined

  return new DatadogSpanContext({
    traceId: id(traceId.slice(-16), 16),
    spanId: id(spanId, 16),
    sampling: { priority: (Number.parseInt(flags, 16) & 1) === 1 ? AUTO_KEEP : AUTO_REJECT },
    traceparent: { version },
    tracestate: TraceState.fromString(spanContext.toTracestate()),
    isRemote: false,
    trace,
  })
}

/**
 * Returns whether distributed trace headers are present.
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {boolean}
 */
function hasTraceHeaders (headers) {
  return !!(headers && (readDatadogTraceId(headers) || readTraceparent(headers)))
}

/**
 * Initializes WebSocket message counters for a socket.
 * @param {object} socket - The WebSocket socket object
 */
function initWebSocketMessageCounters (socket) {
  if (!socketCounters.has(socket)) {
    socketCounters.set(socket, {
      receiveCounter: 0,
      sendCounter: 0,
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
 * @param {string|bigint} handshakeTraceId - The trace ID from the handshake span
 * @param {string|bigint} handshakeSpanId - The span ID from the handshake span
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
  const traceIdHex = typeof handshakeTraceId === 'string'
    ? handshakeTraceId.padStart(32, '0')
    : handshakeTraceId.toString(16).padStart(32, '0')

  // Pad span ID to 16 hex chars (64 bits)
  const spanIdHex = typeof handshakeSpanId === 'string'
    ? handshakeSpanId.padStart(16, '0')
    : handshakeSpanId.toString(16).padStart(16, '0')

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
 * @param {DatadogSpanContext} spanContext - The handshake span context
 * @param {{ hasTraceHeaders?: boolean } | undefined} socket - The WebSocket socket object
 * @returns {boolean} True if the span has distributed tracing context
 */
function hasDistributedTracingContext (spanContext, socket) {
  return Boolean(spanContext && socket?.hasTraceHeaders)
}

module.exports = {
  createWebSocketSpanContext,
  hasTraceHeaders,
  initWebSocketMessageCounters,
  incrementWebSocketCounter,
  buildWebSocketSpanPointerHash,
  hasDistributedTracingContext,
}
