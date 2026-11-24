'use strict'

const { Identifier } = require('../../id')

/**
 * @typedef {import('../../span_format').FormattedSpan} FormattedSpan
 * @typedef {Omit<FormattedSpan, 'trace_id' | 'span_id' | 'parent_id' | 'service' | 'type' |
 *   'links' | 'meta_struct' | 'span_events'> & {
 *   trace_id: string, span_id: string, parent_id: string, service?: string, type?: string
 * }} WorkerTraceSpan
 * @typedef {Array<WorkerTraceSpan[keyof WorkerTraceSpan] | null>} PackedTrace
 * @typedef {PackedTrace | string} WorkerTraceItem
 * @typedef {WorkerTraceItem[] | string} WorkerTraceBatch
 */

const MAX_NUMBER_BYTES = 32
const MAX_STRING_BYTES_PER_UNIT = 6
const PACKED_SPAN_LENGTH = 13
const SPAN_OVERHEAD_BYTES = JSON.stringify({
  trace_id: '',
  span_id: '',
  parent_id: '',
  name: '',
  resource: '',
  service: '',
  type: '',
  trace_state: '',
  error: 0,
  start: 0,
  duration: 0,
  meta: {},
  metrics: {},
}).length + 3 * (MAX_NUMBER_BYTES - 1)

/** @param {number} value */
function isJSONNumber (value) {
  return Number.isFinite(value) && !Object.is(value, -0)
}

/**
 * Bounds each UTF-16 unit by a JSON Unicode escape, without serializing its string.
 * @param {FormattedSpan[]} trace
 * @param {number} maxBytes
 */
function packTrace (trace, maxBytes) {
  const data = []
  let bytes = 2
  for (let index = 0; index < trace.length; index++) {
    const span = trace[index]
    if (span == null || span.meta_struct !== undefined || span.span_events !== undefined ||
      !(span.trace_id instanceof Identifier) || !(span.span_id instanceof Identifier) ||
      !(span.parent_id instanceof Identifier) || !isJSONNumber(span.start) || !isJSONNumber(span.duration) ||
      !isJSONNumber(span.error)) {
      return
    }

    const { name, resource, service, type, trace_state: traceState, error, meta, metrics, start, duration } = span
    const traceId = span.trace_id.toJSON()
    const spanId = span.span_id.toJSON()
    const parentId = span.parent_id.toJSON()
    bytes += SPAN_OVERHEAD_BYTES + 1 + traceId.length + spanId.length + parentId.length + MAX_STRING_BYTES_PER_UNIT * (
      name.length + resource.length + (service?.length ?? 0) + (type?.length ?? 0) + (traceState?.length ?? 0)
    )
    for (const key of Object.keys(meta)) {
      const value = meta[key]
      if (typeof value !== 'string') return
      bytes += 6 + MAX_STRING_BYTES_PER_UNIT * (key.length + value.length)
    }
    for (const key of Object.keys(metrics)) {
      if (!isJSONNumber(metrics[key])) return
      bytes += 4 + MAX_NUMBER_BYTES + MAX_STRING_BYTES_PER_UNIT * key.length
    }
    if (bytes > maxBytes) return

    data.push(
      traceId, spanId, parentId, name, resource, service, type, error, meta, metrics, start, duration, traceState
    )
  }
  return { data, bytes }
}

/**
 * Counts fallback bytes after the JSON IPC layer quotes and escapes the inner JSON.
 * @param {unknown} trace
 * @param {number} maxBytes
 */
function encodeWorkerTrace (trace, maxBytes) {
  if (Array.isArray(trace)) {
    const packed = packTrace(trace, maxBytes)
    if (packed !== undefined) return packed
  }
  const data = JSON.stringify(trace) ?? 'null'
  let bytes = Buffer.byteLength(data) + 2
  for (let index = 0; index < data.length; index++) {
    const codeUnit = data.charCodeAt(index)
    if (codeUnit === 0x22 || codeUnit === 0x5C) {
      bytes++
    } else if (codeUnit >= 0xD8_00 && codeUnit <= 0xDF_FF) {
      if (data.codePointAt(index) === codeUnit) {
        bytes += 3
      } else {
        index++
      }
    }
  }
  return { data, bytes }
}

/**
 * JSON-mode forks turn undefined array slots into null.
 * @param {PackedTrace} data
 */
function unpackTrace (data) {
  if (data.length % PACKED_SPAN_LENGTH !== 0) throw new TypeError('incomplete packed span')
  const trace = []
  for (let index = 0; index < data.length; index += PACKED_SPAN_LENGTH) {
    const span = /** @type {WorkerTraceSpan} */ ({
      trace_id: data[index],
      span_id: data[index + 1],
      parent_id: data[index + 2],
      name: data[index + 3],
      resource: data[index + 4],
      error: data[index + 7],
      meta: data[index + 8],
      metrics: data[index + 9],
      start: data[index + 10],
      duration: data[index + 11],
    })
    const service = /** @type {string | null | undefined} */ (data[index + 5])
    const type = /** @type {string | null | undefined} */ (data[index + 6])
    const traceState = /** @type {string | null | undefined} */ (data[index + 12])
    if (service != null) span.service = service
    if (type != null) span.type = type
    if (traceState != null) span.trace_state = traceState
    trace.push(span)
  }
  return trace
}

/**
 * @param {WorkerTraceBatch} batch
 * @returns {WorkerTraceSpan[][]}
 */
function decodeWorkerTraces (batch) {
  const legacy = typeof batch === 'string'
  const traces = legacy ? JSON.parse(batch) : batch
  if (!Array.isArray(traces)) throw new TypeError('expected an array')

  for (let index = 0; index < traces.length; index++) {
    const item = traces[index]
    const serialized = !legacy && typeof item === 'string'
    const trace = serialized ? JSON.parse(item) : item
    if (!Array.isArray(trace)) throw new TypeError('expected a trace array')
    if (!legacy) traces[index] = serialized ? trace : unpackTrace(trace)
  }
  return traces
}

module.exports = { encodeWorkerTrace, decodeWorkerTraces }
