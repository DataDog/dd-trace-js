'use strict'

// A minimal trace sink: accepts `PUT /v0.4/traces` and normalizes each span into one
// comparable shape, so a baseline run and a native run line up field by field. The repo's
// own mock agent (`test/plugins/agent.js`) is built around the plugin-test harness rather
// than a standalone driver, so this stands in for it.
//
// With `decode: false` the body is discarded unread — that is the mode the end-to-end
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
    if (request.method !== 'PUT' || request.url !== '/v0.4/traces') {
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
        for (const chunk of normalize(payload)) {
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
 * The wire is an array of traces, each an array of maps keyed by field name.
 *
 * @param {Array<Array<Record<string, unknown>>>} payload
 * @returns {CapturedSpan[][]}
 */
function normalize (payload) {
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

module.exports = { startCaptureServer }
