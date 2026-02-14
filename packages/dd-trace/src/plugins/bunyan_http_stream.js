'use strict'

const http = require('http')
const https = require('https')
const { Writable } = require('stream')
const log = require('../log')

/**
 * Custom Bunyan stream that forwards logs to HTTP/HTTPS endpoint
 * Implements Bunyan's raw stream interface (receives objects, not strings)
 */
class BunyanHttpStream extends Writable {
  constructor (options) {
    super({ objectMode: true })

    this.host = options.host
    this.port = options.port
    this.path = options.path || '/logs'
    this.protocol = options.protocol || 'http:'
    this.httpModule = this.protocol === 'https:' ? https : http
    this.timeout = options.timeout || 5000

    this.buffer = []
    this.maxBufferSize = options.maxBufferSize || 1000
    this.flushInterval = options.flushIntervalMs || 5000

    this._startFlushTimer()

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
      this.buffer.push(record)

      // Flush if buffer is full
      if (this.buffer.length >= this.maxBufferSize) {
        this._flush()
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
  _flush () {
    if (this.buffer.length === 0) return

    const logs = this.buffer.splice(0, this.buffer.length)
    const payload = JSON.stringify(logs)

    const req = this.httpModule.request({
      hostname: this.host,
      port: this.port,
      path: this.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: this.timeout
    }, (res) => {
      // Consume response to free up socket
      res.resume()
    })

    req.on('error', (err) => {
      // Silently fail - never crash the app
      log.debug('Bunyan HTTP stream request failed: %s', err.message)
    })

    req.on('timeout', () => {
      req.destroy()
      log.debug('Bunyan HTTP stream request timed out')
    })

    req.write(payload)
    req.end()
  }

  /**
   * Start automatic flush timer
   */
  _startFlushTimer () {
    this.timer = setInterval(() => this._flush(), this.flushInterval)
    this.timer.unref() // Don't prevent process exit
  }

  /**
   * Close stream and flush remaining logs
   */
  close () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this._flush()
  }
}

module.exports = BunyanHttpStream
