'use strict'

const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { urlToHttpOptions } = require('../../exporters/common/url-to-http-options-polyfill')

const RATE_LIMIT_MAX_WAIT_MS = 30_000
const SERVER_ERROR_RETRY_DELAY_MS = 5000

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
 * Simplified HTTP request for test optimization (library config). No custom agent,
 * no form support, no docker info. Retries: 429 (with X-ratelimit-reset, max 30s wait),
 * >=500 (5s delay). Max one retry.
 *
 * @param {string} data - Request body (e.g. JSON string)
 * @param {object} options - { url, path?, method?, headers?, timeout? }
 * @param {Function} callback - (err, res, statusCode) => void
 */
function request (data, options, callback) {
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

  const timeout = options.timeout || 2000
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http

  options.headers['Content-Length'] = Buffer.byteLength(data, 'utf8')

  let hasRetried = false

  const makeRequest = () => {
    storage('legacy').run({ noop: true }, () => {
      const req = client.request(options, (res) => {
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
            hasRetried = true
            setTimeout(makeRequest, SERVER_ERROR_RETRY_DELAY_MS)
            return
          }

          const error = buildError(res, buffer, options)
          callback(error, null, res.statusCode)
        })
      })

      req.once('error', err => {
        callback(err, null)
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
