'use strict'

const http = require('node:http')
const https = require('node:https')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { urlToHttpOptions } = require('../../exporters/common/url-to-http-options-polyfill')
const docker = require('../../exporters/common/docker')
const { httpAgent, httpsAgent } = require('../../exporters/common/agents')

const MAX_CONCURRENCY = 12
const MAX_QUEUE_SIZE = 200
const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 10_000

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504])
const RETRYABLE_NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])

function getBackoffDelay (attempt) {
  const jitter = Math.random() * 500
  return Math.min(RETRY_BASE_MS * (2 ** attempt) + jitter, RETRY_MAX_MS)
}

function parseUrl (urlObjOrString) {
  if (urlObjOrString !== null && typeof urlObjOrString === 'object') return urlToHttpOptions(urlObjOrString)

  const url = urlToHttpOptions(new URL(urlObjOrString))

  if (url.protocol === 'unix:' && url.hostname === '.') {
    const udsPath = urlObjOrString.slice(5)
    url.path = udsPath
    url.pathname = udsPath
  }

  return url
}

function byteLength (data) {
  if (Array.isArray(data)) {
    return data.length > 0 ? data.reduce((prev, next) => prev + Buffer.byteLength(next, 'utf8'), 0) : 0
  }
  return Buffer.byteLength(data, 'utf8')
}

/**
 * Concurrency-limited request queue for Test Optimization payload writers.
 * Unlike the shared common/request.js, this queues instead of silently
 * discarding data when under load, and retries transient failures.
 */
class PayloadRequestQueue {
  _inflight = 0
  _pendingRetries = 0
  _queue = []
  _drainCallbacks = []

  /**
   * @param {Buffer|string|Array<Buffer|string>} data
   * @param {object} options - HTTP options (url, path, method, headers, timeout)
   * @param {Function} callback - (err, res, statusCode) => void
   */
  send (data, options, callback) {
    if (this._inflight < MAX_CONCURRENCY) {
      this._doSend(data, options, callback, 0)
    } else if (this._queue.length < MAX_QUEUE_SIZE) {
      this._queue.push({ data, options, callback, attempt: 0 })
    } else {
      log.warn('Test Optimization request queue full (%d), dropping payload', MAX_QUEUE_SIZE)
      callback(new Error('Payload dropped: queue full'))
    }
  }

  /**
   * Calls callback when all in-flight, queued, and pending-retry requests have completed.
   * @param {Function} callback
   */
  drain (callback) {
    if (this._isIdle()) {
      callback()
    } else {
      this._drainCallbacks.push(callback)
    }
  }

  _isIdle () {
    return this._inflight === 0 && this._queue.length === 0 && this._pendingRetries === 0
  }

  _doSend (data, options, callback, attempt) {
    this._inflight++
    this._makeRequest(data, options, (err, res, statusCode) => {
      this._inflight--

      if (err && attempt + 1 < MAX_RETRIES && this._isRetryable(err, statusCode)) {
        this._pendingRetries++
        setTimeout(() => {
          this._pendingRetries--
          // Route through concurrency check instead of calling _doSend directly
          if (this._inflight < MAX_CONCURRENCY) {
            this._doSend(data, options, callback, attempt + 1)
          } else if (this._queue.length < MAX_QUEUE_SIZE) {
            this._queue.unshift({ data, options, callback, attempt: attempt + 1 })
          } else {
            log.warn('Test Optimization request queue full during retry, dropping payload')
            callback(new Error('Payload dropped: queue full during retry'))
          }
          this._processQueue()
        }, getBackoffDelay(attempt))
      } else {
        callback(err, res, statusCode)
      }

      this._processQueue()
    })
  }

  _processQueue () {
    while (this._queue.length > 0 && this._inflight < MAX_CONCURRENCY) {
      const { data, options, callback, attempt = 0 } = this._queue.shift()
      this._doSend(data, options, callback, attempt)
    }

    if (this._isIdle() && this._drainCallbacks.length > 0) {
      const callbacks = this._drainCallbacks.splice(0)
      for (const cb of callbacks) cb()
    }
  }

  _isRetryable (err, statusCode) {
    if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) return true
    if (err.code && RETRYABLE_NETWORK_ERRORS.has(err.code)) return true
    return false
  }

  _makeRequest (data, options, callback) {
    if (!options.headers) {
      options.headers = {}
    }

    if (options.url) {
      const url = parseUrl(options.url)
      if (url.protocol === 'unix:') {
        options.socketPath = url.pathname
      } else {
        if (!options.path) options.path = url.path
        options.protocol = url.protocol
        options.hostname = url.hostname
        options.port = url.port
      }
    }

    const timeout = options.timeout || 15_000
    const isSecure = options.protocol === 'https:'
    const client = isSecure ? https : http

    let dataArray = data
    if (!Array.isArray(data)) {
      dataArray = [data]
    }
    options.headers['Content-Length'] = byteLength(data)
    docker.inject(options.headers)
    options.agent = isSecure ? httpsAgent : httpAgent

    storage('legacy').run({ noop: true }, () => {
      const req = client.request(options, (res) => {
        const chunks = []
        res.setTimeout(timeout)
        res.on('data', chunk => chunks.push(chunk))
        res.once('end', () => {
          const buffer = Buffer.concat(chunks)
          if (res.statusCode >= 200 && res.statusCode <= 299) {
            callback(null, buffer.toString(), res.statusCode)
            return
          }
          const error = new log.NoTransmitError(
            `Test Optimization payload error: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`
          )
          error.status = res.statusCode
          callback(error, null, res.statusCode)
        })
      })

      req.once('error', err => callback(err, null))

      req.setTimeout(timeout, () => {
        req.destroy()
      })

      for (const buffer of dataArray) req.write(buffer)
      req.end()
    })
  }
}

module.exports = PayloadRequestQueue
