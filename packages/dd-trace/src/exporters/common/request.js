'use strict'

// TODO: Add test with slow or unresponsive agent.
// TODO: Add telemetry for things like dropped requests, errors, etc.

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { urlToHttpOptions } = require('./url-to-http-options-polyfill')
const docker = require('./docker')
const { httpAgent, httpsAgent } = require('./agents')
const {
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
  markEndpointReached,
} = require('./retry')

const maxActiveBufferSize = 1024 * 1024 * 64

let activeBufferSize = 0

/**
 * @param {string|URL|object} urlObjOrString
 * @returns {object}
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

/**
 * @param {Buffer|string|Readable|Array<Buffer|string>} data
 * @param {object} options
 * @param {(error: Error|null, result: string, statusCode: number) => void} callback
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
      options.hostname = url.hostname // for IPv6 this should be '::1' and not '[::1]'
      options.port = url.port
    }
  }

  if (data instanceof Readable) {
    const chunks = []

    data
      .on('data', (data) => {
        chunks.push(data)
      })
      .on('end', () => {
        request(Buffer.concat(chunks), options, callback)
      })
      .on('error', (err) => {
        callback(err)
      })

    return
  }

  // The timeout should be kept low to avoid excessive queueing.
  const timeout = options.timeout || 2000
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http
  let dataArray = data

  if (!Array.isArray(data)) {
    dataArray = [data]
  }
  options.headers['Content-Length'] = byteLength(dataArray)

  docker.inject(options.headers)

  options.agent = isSecure ? httpsAgent : httpAgent

  const onResponse = (res, finalize) => {
    markEndpointReached()

    const chunks = []

    res.setTimeout(timeout)

    res.on('data', chunk => {
      chunks.push(chunk)
    })

    res.once('end', () => {
      finalize()
      const buffer = Buffer.concat(chunks)

      if (res.statusCode >= 200 && res.statusCode <= 299) {
        const isGzip = res.headers['content-encoding'] === 'gzip'
        if (isGzip) {
          zlib.gunzip(buffer, (err, result) => {
            if (err) {
              log.error('Could not gunzip response: %s', err.message)
              callback(null, '', res.statusCode, res.headers)
            } else {
              callback(null, result.toString(), res.statusCode, res.headers)
            }
          })
        } else {
          callback(null, buffer.toString(), res.statusCode, res.headers)
        }
      } else {
        let errorMessage = ''
        try {
          const fullUrl = new URL(
            options.path,
            options.url || options.hostname || `http://localhost:${options.port}`
          ).href
          errorMessage = `Error from ${fullUrl}: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}.`
        } catch {
          // ignore error
        }

        const responseData = buffer.toString()
        if (responseData) {
          errorMessage += ` Response from the endpoint: "${responseData}"`
        }
        const error = new log.NoTransmitError(errorMessage)
        error.status = res.statusCode

        callback(error, null, res.statusCode, res.headers)
      }
    })
  }

  // Retries always run via setTimeout so the AsyncLocalStorage store survives
  // the gap before socket.connect(); ALS.run() does not call ALS.enterWith()
  // outside AsyncContextFrame, so a synchronous re-entry would lose the store.
  const attempt = attemptIndex => {
    if (!request.writable) {
      log.debug('Maximum number of active requests reached: payload is discarded.')
      return callback(null)
    }

    activeBufferSize += options.headers['Content-Length'] ?? 0

    storage('legacy').run({ noop: true }, () => {
      let finished = false
      const finalize = () => {
        if (finished) return
        finished = true
        activeBufferSize -= options.headers['Content-Length'] ?? 0
      }

      const req = client.request(options, (res) => onResponse(res, finalize))

      req.once('close', finalize)
      req.once('timeout', finalize)

      req.once('error', error => {
        finalize()
        if (attemptIndex < getMaxAttempts() && isRetriableNetworkError(error)) {
          setTimeout(attempt, getRetryDelay(attemptIndex), attemptIndex + 1)
        } else {
          callback(error)
        }
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

      for (const buffer of dataArray) req.write(buffer)
      req.end()
    })
  }

  attempt(1)
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + Buffer.byteLength(next, 'utf8'), 0) : 0
}

Object.defineProperty(request, 'writable', {
  get () {
    return activeBufferSize < maxActiveBufferSize
  },
})

module.exports = request
