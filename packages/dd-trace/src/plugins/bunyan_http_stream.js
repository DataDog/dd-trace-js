'use strict'

const http = require('node:http')
const https = require('node:https')
const { Writable } = require('node:stream')
const log = require('../log')

/**
 * Custom Bunyan stream that forwards logs to HTTP/HTTPS endpoint
 * Implements Bunyan's raw stream interface (receives objects, not strings)
 */
class BunyanHttpStream extends Writable {
  #host
  #port
  #path
  #httpModule
  #timeout
  #buffer = []
  #maxBufferSize
  #flushInterval
  #timer

  constructor (options) {
    super({ objectMode: true })

    this.#host = options.host
    this.#port = options.port
    this.#path = options.path || '/logs'
    this.#httpModule = (options.protocol || 'http:') === 'https:' ? https : http
    this.#timeout = options.timeout || 5000
    this.#maxBufferSize = options.maxBufferSize || 1000
    this.#flushInterval = options.flushIntervalMs || 5000

    this.#startFlushTimer()

    // Register cleanup on process exit
    const exitHandler = () => this.close()
    const ddTrace = globalThis[Symbol.for('dd-trace')]
    if (ddTrace?.beforeExitHandlers) {
      ddTrace.beforeExitHandlers.add(exitHandler)
    } else {
      process.once('beforeExit', exitHandler)
    }
  }

  /**
   * Writable stream _write implementation
   * Bunyan calls this with log record objects
   * @param {object} record - Bunyan log record
   * @param {string} encoding - Encoding (ignored for objectMode)
   * @param {Function} callback - Completion callback
   */
  _write (record, encoding, callback) {
    try {
      this.#buffer.push(record)

      // Flush if buffer is full
      if (this.#buffer.length >= this.#maxBufferSize) {
        this.#flush()
      }

      callback()
    } catch (err) {
      // Never crash the application
      log.debug('Error buffering Bunyan log: %s', err.message)
      callback()
    }
  }

  /**
   * Flush buffered logs to HTTP endpoint
   */
  #flush () {
    if (this.#buffer.length === 0) return

    const logs = this.#buffer.splice(0, this.#buffer.length)
    const payload = JSON.stringify(logs)

    const req = this.#httpModule.request({
      hostname: this.#host,
      port: this.#port,
      path: this.#path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: this.#timeout
    }, (res) => {
      // Consume response to free up socket
      res.resume()
    })

    req.once('error', (err) => {
      // Silently fail - never crash the app
      log.debug('Bunyan HTTP stream request failed: %s', err.message)
    })

    req.once('timeout', () => {
      req.destroy()
      log.debug('Bunyan HTTP stream request timed out')
    })

    req.write(payload)
    req.end()
  }

  /**
   * Start automatic flush timer
   */
  #startFlushTimer () {
    this.#timer = setInterval(() => this.#flush(), this.#flushInterval)
    this.#timer.unref() // Don't prevent process exit
  }

  /**
   * Close stream and flush remaining logs
   */
  close () {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    this.#flush()
  }
}

module.exports = BunyanHttpStream
