'use strict'

const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { urlToHttpOptions } = require('../../exporters/common/url-to-http-options-polyfill')

const RATE_LIMIT_MAX_WAIT_MS = 30_000
const RETRY_BASE_MS = 5000
const RETRY_JITTER_MS = 2500

// Dedicated HTTP agents for CI visibility requests, isolated from global agent pool.
// Connection pooling helps when a process makes multiple CI visibility requests
// (e.g. library config + skippable suites + known tests in the same Jest session).
const ciVisibilityAgent = {
  http: new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 2,
    maxFreeSockets: 1,
  }),
  https: new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 2,
    maxFreeSockets: 1,
  }),
}

/**
 * Calculates retry delay with jitter to prevent thundering herd.
 * Delay is RETRY_BASE_MS + random(0, RETRY_JITTER_MS) (e.g. 5–7.5 seconds).
 *
 * @returns {number} Delay in milliseconds
 */
function getRetryDelay () {
  return RETRY_BASE_MS + (Math.random() * RETRY_JITTER_MS)
}

/**
 * Determines if a network error is retriable (transient failures only).
 * ENOTFOUND and ECONNREFUSED are excluded as they are usually not transient.
 *
 * @param {Error} err - The error to check
 * @returns {boolean}
 */
function isRetriableNetworkError (err) {
  if (!err.code) return false
  return err.code === 'ECONNRESET' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'EPIPE'
}

function parseUrl (urlObjOrString) {
  if (urlObjOrString !== null && typeof urlObjOrString === 'object') {
    return urlToHttpOptions(urlObjOrString)
  }

  const url = urlToHttpOptions(new URL(urlObjOrString))

  if (url.protocol === 'unix:' && url.hostname === '.') {
    const udsPath = urlObjOrString.slice(5)
    url.path = udsPath
    url.pathname = udsPath
  }

  return url
}

/**
 * Simplified HTTP request for test optimization (library config). Uses dedicated agent
 * with connection pooling. Retries: 429 (with X-ratelimit-reset, max 30s wait),
 * >=500 and transient network errors (5–7.5s delay with jitter). Max one retry.
 * Destroys connections on errors to prevent reuse of bad connections. Preserves
 * original status code across retries for telemetry.
 *
 * @param {string} data - Request body (e.g. JSON string)
 * @param {object} options - { url, path?, method?, headers?, timeout? } (may be mutated)
 * @param {Function} callback - (err, res, statusCode) => void
 */
function request (data, options, callback) {
  const headers = options.headers ? { ...options.headers } : {}
  headers['Content-Length'] = Buffer.byteLength(data, 'utf8')

  const opts = { ...options, method: 'POST', headers }

  if (opts.url) {
    const url = parseUrl(opts.url)
    if (url.protocol === 'unix:') {
      opts.socketPath = url.pathname
    } else {
      opts.path = opts.path ?? url.path
      opts.protocol = url.protocol
      opts.hostname = url.hostname
      opts.port = url.port
    }
  }

  const timeout = opts.timeout || 2000
  const isSecure = opts.protocol === 'https:'
  const client = isSecure ? https : http

  if (!opts.socketPath) {
    opts.agent = isSecure ? ciVisibilityAgent.https : ciVisibilityAgent.http
  }

  let hasRetried = false
  let firstStatusCode = null

  const makeRequest = () => {
    storage('legacy').run({ noop: true }, () => {
      const req = client.request(opts, (res) => {
        const chunks = []

        res.setTimeout(timeout)

        res.on('data', chunk => {
          chunks.push(chunk)
        })

        res.once('end', () => {
          const buffer = Buffer.concat(chunks)

          if (res.statusCode >= 200 && res.statusCode <= 299) {
            const isGzip = res.headers['content-encoding'] === 'gzip'
            if (isGzip) {
              zlib.gunzip(buffer, (err, result) => {
                if (err) {
                  log.error('Could not gunzip response: %s', err.message)
                  callback(null, '', res.statusCode)
                } else {
                  callback(null, result.toString(), res.statusCode)
                }
              })
            } else {
              callback(null, buffer.toString(), res.statusCode)
            }
            return
          }

          if (res.statusCode === 429 && !hasRetried) {
            const resetHeader = res.headers['x-ratelimit-reset']
            const resetTs = (resetHeader === null || resetHeader === undefined)
              ? Number.NaN
              : Number.parseInt(resetHeader, 10)
            const waitMs = Number.isFinite(resetTs) ? Math.max(0, resetTs * 1000 - Date.now()) : Number.NaN

            if (Number.isFinite(waitMs) && waitMs <= RATE_LIMIT_MAX_WAIT_MS) {
              hasRetried = true
              setTimeout(makeRequest, waitMs)
              return
            }

            if (!Number.isFinite(waitMs) || waitMs > RATE_LIMIT_MAX_WAIT_MS) {
              log.debug('Rate limited (429): drop payload (wait %sms > %sms or invalid header)',
                Number.isFinite(waitMs) ? waitMs : 'N/A', RATE_LIMIT_MAX_WAIT_MS)
            }
          } else if (res.statusCode >= 500 && !hasRetried) {
            // Track original status code for telemetry
            if (firstStatusCode === null) {
              firstStatusCode = res.statusCode
            }
            try {
              if (req.socket) req.socket.destroy()
            } catch {
              // ignore
            }
            hasRetried = true
            setTimeout(makeRequest, getRetryDelay())
            return
          }

          const error = buildError(res, buffer, opts)
          // Use original status code if this is a failed retry
          callback(error, null, firstStatusCode === null ? res.statusCode : firstStatusCode)
        })
      })

      req.once('error', err => {
        try {
          if (req.socket) req.socket.destroy()
        } catch {
          // ignore
        }

        // Retry on retriable network errors
        if (!hasRetried && isRetriableNetworkError(err)) {
          hasRetried = true
          setTimeout(makeRequest, getRetryDelay())
          return
        }

        // Pass original status code (if any) for accurate telemetry
        callback(err, null, firstStatusCode)
      })

      req.setTimeout(timeout, () => {
        try {
          if (typeof req.abort === 'function') {
            req.abort()
          } else {
            req.destroy()
          }
        } catch {
          // ignore
        }
      })

      req.write(data, 'utf8')
      req.end()
    })
  }

  makeRequest()
}

/**
 * @param {object} res - IncomingMessage
 * @param {Buffer} buffer - Response body
 * @param {object} options - Request options
 * @returns {Error}
 */
function buildError (res, buffer, options) {
  let errorMessage = ''
  try {
    const fullUrl = new URL(
      options.path,
      options.url || options.hostname || `http://localhost:${options.port}`
    ).href
    errorMessage = `Error from ${fullUrl}: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}.`
  } catch {
    // ignore
  }

  const responseData = buffer.toString()
  if (responseData) {
    errorMessage += ` Response from the endpoint: "${responseData}"`
  }

  const error = new log.NoTransmitError(errorMessage)
  error.status = res.statusCode
  return error
}

module.exports = request
