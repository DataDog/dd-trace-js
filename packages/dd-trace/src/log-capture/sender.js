'use strict'

const http = require('node:http')
const https = require('node:https')

const log = require('../log')

/**
 * @typedef {{ host: string, port: number, path: string, protocol: string,
 *   maxBufferSize: number, flushIntervalMs: number, timeoutMs: number }} SenderOpts
 */

/** @type {SenderOpts | undefined} */
let opts

/** @type {string[]} */
let buffer = []

/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer

/**
 * Configure the sender. Safe to call multiple times — re-configuration flushes
 * any buffered records under the old config before switching to the new one.
 * @param {SenderOpts} options
 */
function configure (options) {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }

  // Flush any records buffered before this configuration (e.g. on re-configure).
  flush()

  opts = options
}

/**
 * Add a JSON log line to the buffer.
 * Arms a one-shot flush timer on the first record added after a flush.
 * @param {string} jsonLine
 */
function add (jsonLine) {
  if (opts === undefined) return
  if (buffer.length >= opts.maxBufferSize) {
    flush()
  }
  buffer.push(jsonLine)
  if (timer === undefined) {
    timer = setTimeout(flushAndReschedule, opts.flushIntervalMs)
    timer.unref?.()
  }
}

/**
 * Flush buffered records and re-arm the timer if more records arrived during flush.
 */
function flushAndReschedule () {
  timer = undefined
  flush()
  if (buffer.length > 0) {
    timer = setTimeout(flushAndReschedule, opts.flushIntervalMs)
    timer.unref?.()
  }
}

/**
 * Return the current number of buffered records.
 * @returns {number}
 */
function bufferSize () {
  return buffer.length
}

/**
 * Flush buffered log records to the HTTP/HTTPS intake as NDJSON.
 * The buffer is drained before sending so concurrent flushes do not double-send.
 */
function flush () {
  if (opts === undefined || buffer.length === 0) return

  const records = buffer
  buffer = []

  const body = records.map(r => r.trimEnd()).join('\n')

  const transport = opts.protocol === 'https:' ? https : http

  const reqOpts = {
    host: opts.host,
    port: opts.port,
    path: opts.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: opts.timeoutMs,
  }

  const req = transport.request(reqOpts, (res) => {
    res.resume() // drain the response body so the socket can be released
  })

  req.once('error', (err) => {
    log.warn('Log capture flush error: %s', err.message)
  })

  req.once('timeout', () => {
    log.warn('Log capture flush timed out')
    req.destroy()
  })

  req.write(body)
  req.end()
}

/**
 * Stop the sender: cancel any pending flush timer and reset all state.
 * Intended for use in tests and graceful shutdown.
 */
function stop () {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  buffer = []
  opts = undefined
}

module.exports = { configure, add, bufferSize, flush, stop }
