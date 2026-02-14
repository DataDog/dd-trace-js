'use strict'

const http = require('http')
const https = require('https')

/**
 * Pino transport that sends logs to HTTP/HTTPS endpoint
 * Compatible with Pino's transport interface
 *
 * @param {object} options - Transport configuration
 * @param {string} options.host - HTTP server host
 * @param {number} options.port - HTTP server port
 * @param {string} [options.path='/logs'] - HTTP endpoint path
 * @param {string} [options.protocol='http:'] - Protocol (http: or https:)
 * @param {number} [options.maxBufferSize=1000] - Max logs before flush
 * @param {number} [options.flushIntervalMs=5000] - Flush interval in ms
 * @param {number} [options.timeout=5000] - HTTP request timeout
 * @returns {import('stream').Transform} Transform stream for Pino
 */
module.exports = function pinoHttpTransport (options) {
  const {
    host,
    port,
    path = '/logs',
    protocol = 'http:',
    maxBufferSize = 1000,
    flushIntervalMs = 5000,
    timeout = 5000,
  } = options

  const httpModule = protocol === 'https:' ? https : http
  const buffer = []
  let flushTimer = null

  /**
   * Flush buffered logs to HTTP endpoint
   */
  function flush () {
    if (buffer.length === 0) return

    const logs = buffer.splice(0, buffer.length)
    const payload = JSON.stringify(logs)

    const req = httpModule.request(
      {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        // Consume response to free up socket
        res.resume()
      }
    )

    req.on('error', () => {
      // Silent failure - don't crash application
    })

    req.on('timeout', () => {
      req.destroy()
    })

    req.write(payload)
    req.end()
  }

  // Start flush timer
  flushTimer = setInterval(flush, flushIntervalMs)
  flushTimer.unref() // Don't keep process alive

  // Register cleanup on process exit to ensure final flush
  const exitHandler = () => {
    clearInterval(flushTimer)
    flush()
  }
  const ddTrace = globalThis[Symbol.for('dd-trace')]
  if (ddTrace?.beforeExitHandlers) {
    ddTrace.beforeExitHandlers.add(exitHandler)
  } else {
    process.once('beforeExit', exitHandler)
  }

  // Return a Writable stream that Pino can write to
  const { Writable } = require('stream')

  const transport = new Writable({
    write (chunk, encoding, callback) {
      try {
        // Parse the newline-delimited JSON from Pino
        const chunkStr = chunk.toString()
        // Split by newlines in case multiple logs in one chunk
        const lines = chunkStr.split('\n').filter(line => line.trim())

        for (const line of lines) {
          const log = JSON.parse(line)
          buffer.push(log)
        }

        if (buffer.length >= maxBufferSize) {
          flush()
        }

        callback()
      } catch (err) {
        // Skip malformed logs
        callback()
      }
    },
    final (callback) {
      // Flush remaining logs on close
      clearInterval(flushTimer)
      flush()
      callback()
    },
  })

  return transport
}
