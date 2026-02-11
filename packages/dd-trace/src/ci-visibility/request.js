'use strict'

const http = require('http')
const https = require('https')
const zlib = require('zlib')
const log = require('../log')
const { urlToHttpOptions } = require('../exporters/common/url-to-http-options-polyfill')

/**
 * Simplified HTTP request module for CI Visibility test optimization requests.
 * Unlike the common request module, this:
 * - Has no maximum concurrent request limit (test optimization requests are infrequent and critical)
 * - Has no automatic retry mechanism (caller can decide whether to retry)
 * - Has no custom HTTP agents (uses Node.js defaults)
 * - Supports only string/Buffer request bodies (no streams)
 * - Logs only errors (not debug messages)
 */

function parseUrl (urlObjOrString) {
  if (urlObjOrString !== null && typeof urlObjOrString === 'object') return urlToHttpOptions(urlObjOrString)

  const url = urlToHttpOptions(new URL(urlObjOrString))

  // Special handling if we're using named pipes on Windows
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
 * Makes an HTTP request for CI Visibility test optimization.
 *
 * @param {string|Buffer|Array<string|Buffer>} data - Request body data
 * @param {object} options - Request options
 * @param {string} options.path - Request path
 * @param {string} options.method - HTTP method
 * @param {object} options.headers - HTTP headers
 * @param {number} [options.timeout=20000] - Request timeout in milliseconds
 * @param {string} [options.url] - Base URL
 * @param {string} [options.protocol] - Protocol (http: or https:)
 * @param {string} [options.hostname] - Hostname
 * @param {number} [options.port] - Port
 * @param {Function} callback - Callback function (err, response, statusCode)
 */
function request (data, options, callback) {
  const requestType = options.requestType || 'test-optimization'

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

  const timeout = options.timeout || 20_000
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http

  const dataArray = Array.isArray(data) ? data : [data]
  const contentLength = byteLength(dataArray)
  options.headers['Content-Length'] = contentLength

  const onResponse = (res) => {
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
              log.error('[%s] Could not gunzip response: %s', requestType, err.message)
              return callback(err, null, res.statusCode)
            }
            callback(null, result.toString(), res.statusCode)
          })
        } else {
          callback(null, buffer.toString(), res.statusCode)
        }
      } else {
        let errorMessage
        try {
          const fullUrl = new URL(
            options.path,
            options.url || options.hostname || `http://localhost:${options.port}`
          ).href
          errorMessage = `Error from ${fullUrl}: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}.`
        } catch {
          errorMessage = `HTTP ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`
        }

        const responseData = buffer.toString()
        if (responseData) {
          errorMessage += ` Response from the endpoint: "${responseData}"`
        }

        log.error('[%s] Request failed: %s', requestType, errorMessage)

        const error = new Error(errorMessage)
        error.status = res.statusCode
        callback(error, null, res.statusCode)
      }
    })

    res.once('error', (err) => {
      log.error('[%s] Response stream error: %s', requestType, err.message)
      callback(err, null, res.statusCode)
    })
  }

  let finished = false
  const finalize = () => {
    if (finished) return
    finished = true
  }

  try {
    const req = client.request(options, onResponse)

    req.once('close', finalize)

    req.once('timeout', () => {
      log.error('[%s] Request timeout after %dms', requestType, timeout)
      finalize()
    })

    req.once('error', (err) => {
      log.error('[%s] Request error: %s', requestType, err.message)
      finalize()
      callback(err, null, null)
    })

    req.setTimeout(timeout, () => {
      log.error('[%s] Request timed out, aborting', requestType)
      try {
        if (typeof req.abort === 'function') {
          req.abort()
        } else {
          req.destroy()
        }
      } catch (err) {
        log.error('[%s] Error aborting request: %s', requestType, err.message)
      }
    })

    for (const buffer of dataArray) {
      req.write(buffer)
    }
    req.end()
  } catch (err) {
    log.error('[%s] Exception creating request: %s', requestType, err.message)
    callback(err, null, null)
  }
}

module.exports = request
