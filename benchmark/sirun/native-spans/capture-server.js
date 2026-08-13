'use strict'

// A minimal trace sink. The existing mock agent (`test/plugins/agent.js`) 404s on
// `/v0.5/traces`, which is the only endpoint the native path speaks, so the harness
// stands up its own.
//
// Accepts `PUT` on both `/v0.4/traces` and `/v0.5/traces` and normalizes each into
// one shape, so a baseline run and a native run are comparable field by field. With
// `decode: false` the body is discarded unread — that is the mode the end-to-end
// benchmark wants, where decoding would put the harness's own cost into the numbers.

const http = require('node:http')

const { decode } = require('@msgpack/msgpack')

/**
 * @typedef {object} CapturedSpan
 * @property {string} service
 * @property {string} name
 * @property {string} resource
 * @property {string} type
 * @property {string} trace_id
 * @property {string} span_id
 * @property {string} parent_id
 * @property {number} start
 * @property {number} duration
 * @property {number} error
 * @property {Record<string, string>} meta
 * @property {Record<string, number>} metrics
 */

/**
 * @param {{
 *   decode?: boolean,
 *   port?: number,
 *   onChunk?: (chunk: CapturedSpan[]) => void,
 * }} [options]
 * @returns {Promise<{
 *   port: number,
 *   chunks: CapturedSpan[][],
 *   requestCount: () => number,
 *   close: () => Promise<void>,
 * }>}
 */
function startCaptureServer ({ decode: shouldDecode = true, port = 0, onChunk } = {}) {
  /** @type {CapturedSpan[][]} */
  const chunks = []
  let requestCount = 0

  const server = http.createServer((request, response) => {
    if (request.method !== 'PUT' || !/^\/v0\.[45]\/traces$/.test(request.url)) {
      response.writeHead(404).end()
      return
    }

    requestCount++

    if (!shouldDecode) {
      request.resume()
      request.on('end', () => { response.writeHead(200).end('{}') })
      return
    }

    /** @type {Buffer[]} */
    const parts = []
    request.on('data', part => parts.push(part))
    request.on('end', () => {
      try {
        // `useBigInt64` keeps 64-bit ids exact; without it the decoder rounds them
        // through a double and parent/child linkage stops matching.
        const payload = decode(Buffer.concat(parts), { useBigInt64: true })
        const decoded = request.url === '/v0.5/traces'
          ? normalizeV05(payload)
          : normalizeV04(payload)
        for (const chunk of decoded) {
          chunks.push(chunk)
          onChunk?.(chunk)
        }
      } catch (error) {
        process.stderr.write(`capture-server: failed to decode payload: ${error.message}\n`)
      }
      response.writeHead(200).end('{}')
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        chunks,
        requestCount: () => requestCount,
        close: () => new Promise(resolve => server.close(() => resolve())),
      })
    })
    server.once('error', reject)
  })
}

/**
 * v0.4 is an array of chunks, each an array of maps keyed by field name.
 *
 * @param {Array<Array<Record<string, unknown>>>} payload
 * @returns {CapturedSpan[][]}
 */
function normalizeV04 (payload) {
  return payload.map(chunk => chunk.map(span => ({
    service: text(span.service),
    name: text(span.name),
    resource: text(span.resource),
    type: text(span.type),
    trace_id: identifier(span.trace_id),
    span_id: identifier(span.span_id),
    parent_id: identifier(span.parent_id),
    start: Number(span.start ?? 0),
    duration: Number(span.duration ?? 0),
    error: Number(span.error ?? 0),
    meta: stringMap(span.meta),
    metrics: numberMap(span.metrics),
  })))
}

// v0.5 is `[stringTable, traces]`, and each span is a 12-slot array whose string
// fields are indices into the table.
const V05_SERVICE = 0
const V05_NAME = 1
const V05_RESOURCE = 2
const V05_TRACE_ID = 3
const V05_SPAN_ID = 4
const V05_PARENT_ID = 5
const V05_START = 6
const V05_DURATION = 7
const V05_ERROR = 8
const V05_META = 9
const V05_METRICS = 10
const V05_TYPE = 11

/**
 * @param {[string[], Array<Array<Array<unknown>>>]} payload
 * @returns {CapturedSpan[][]}
 */
function normalizeV05 (payload) {
  const [table, traces] = payload
  const lookup = index => table[Number(index)] ?? ''

  return traces.map(chunk => chunk.map(span => ({
    service: lookup(span[V05_SERVICE]),
    name: lookup(span[V05_NAME]),
    resource: lookup(span[V05_RESOURCE]),
    type: lookup(span[V05_TYPE]),
    trace_id: identifier(span[V05_TRACE_ID]),
    span_id: identifier(span[V05_SPAN_ID]),
    parent_id: identifier(span[V05_PARENT_ID]),
    start: Number(span[V05_START] ?? 0),
    duration: Number(span[V05_DURATION] ?? 0),
    error: Number(span[V05_ERROR] ?? 0),
    meta: indexedStringMap(span[V05_META], lookup),
    metrics: indexedNumberMap(span[V05_METRICS], lookup),
  })))
}

function text (value) {
  return value === undefined || value === null ? '' : String(value)
}

/**
 * Ids arrive as `number`, `bigint` or a byte array depending on the encoder and the
 * magnitude; decimal strings make the two implementations directly comparable.
 *
 * @param {unknown} value
 * @returns {string}
 */
function identifier (value) {
  if (value === undefined || value === null) return '0'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number') return BigInt(value).toString(10)
  if (value instanceof Uint8Array) {
    let result = 0n
    for (const byte of value) result = (result << 8n) | BigInt(byte)
    return result.toString(10)
  }
  return String(value)
}

function stringMap (value) {
  const out = {}
  if (value) {
    for (const [key, entry] of Object.entries(value)) out[key] = text(entry)
  }
  return out
}

function numberMap (value) {
  const out = {}
  if (value) {
    for (const [key, entry] of Object.entries(value)) out[key] = Number(entry)
  }
  return out
}

function indexedStringMap (value, lookup) {
  const out = {}
  if (value) {
    for (const [key, entry] of Object.entries(value)) out[lookup(key)] = lookup(entry)
  }
  return out
}

function indexedNumberMap (value, lookup) {
  const out = {}
  if (value) {
    for (const [key, entry] of Object.entries(value)) out[lookup(key)] = Number(entry)
  }
  return out
}

module.exports = { startCaptureServer }
