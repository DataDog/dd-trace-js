'use strict'

// TODO: Add test with slow or unresponsive agent.
// TODO: Add telemetry for things like dropped requests, errors, etc.

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { isLoopbackHost, parseUrl } = require('./url')
const docker = require('./docker')
const { httpAgent, httpsAgent } = require('./agents')
const {
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
  markEndpointReached,
} = require('./retry')

const legacyStorage = storage('legacy')

const maxActiveBufferSize = 1024 * 1024 * 64

let activeBufferSize = 0

/**
 * @param {Buffer|string|Readable|Array<Buffer|string>} data
 * @param {object} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
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

  // Never put the Datadog API key on a cleartext connection to a non-loopback host; that would
  // expose it on the wire. Loopback (local agent, dev proxy, tests) is exempt. Strip the key
  // rather than drop the request: the agent proxies telemetry with its own key, while an https
  // intake URL is required to authenticate agentless traffic.
  const hasApiKey = options.headers['dd-api-key'] !== undefined || options.headers['DD-API-KEY'] !== undefined
  if (hasApiKey && options.protocol === 'http:' && !isLoopbackHost(options.hostname)) {
    log.error(
      'Not sending the Datadog API key over a non-TLS connection to %s. Configure an https intake URL.',
      options.hostname
    )
    delete options.headers['dd-api-key']
    delete options.headers['DD-API-KEY']
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

  /**
   * @param {import('node:http').IncomingMessage} res
   * @param {(error: Error|null, result?: string|null, statusCode?: number,
   *   headers?: import('node:http').IncomingHttpHeaders) => void} complete
   * @param {(error: Error) => void} handleError
   */
  const onResponse = (res, complete, handleError) => {
    markEndpointReached(options)

    const chunks = []

    res.setTimeout(timeout)

    res.once('aborted', () => {
      handleError(Object.assign(new Error('Response aborted'), { code: 'ECONNRESET' }))
    })
    res.once('error', handleError)
    res.once('timeout', () => {
      const error = Object.assign(new Error('Response timed out'), { code: 'ETIMEDOUT' })
      res.destroy(error)
      handleError(error)
    })

    res.on('data', chunk => {
      chunks.push(chunk)
    })

    res.once('end', () => {
      const buffer = Buffer.concat(chunks)

      if (res.statusCode >= 200 && res.statusCode <= 299) {
        const contentEncoding = res.headers['content-encoding']
        const isGzip = typeof contentEncoding === 'string' && contentEncoding.toLowerCase() === 'gzip'
        if (isGzip) {
          zlib.gunzip(buffer, (err, result) => {
            if (err) {
              log.error('Could not gunzip response: %s', err.message)
              complete(null, '', res.statusCode, res.headers)
            } else {
              complete(null, result.toString(), res.statusCode, res.headers)
            }
          })
        } else {
          complete(null, buffer.toString(), res.statusCode, res.headers)
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

        complete(error, null, res.statusCode, res.headers)
      }
    })
  }

  // Retries always run via setTimeout so the AsyncLocalStorage store survives
  // the gap before socket.connect(); ALS.run() does not call ALS.enterWith()
  // outside AsyncContextFrame, so a synchronous re-entry would lose the store.
  /** @param {number} attemptIndex */
  const attempt = attemptIndex => {
    if (!request.writable) {
      log.debug('Maximum number of active requests reached: payload is discarded.')
      return callback(null)
    }

    activeBufferSize += options.headers['Content-Length'] ?? 0

    legacyStorage.run({ noop: true }, () => {
      let finished = false
      let settled = false
      const finalize = () => {
        if (finished) return
        finished = true
        activeBufferSize -= options.headers['Content-Length'] ?? 0
      }

      /**
       * @param {Error | null} error
       * @param {string | null} [result]
       * @param {number} [statusCode]
       * @param {import('node:http').IncomingHttpHeaders} [headers]
       */
      const complete = (error, result, statusCode, headers) => {
        if (settled) return
        settled = true
        finalize()
        callback(error, result, statusCode, headers)
      }

      /**
       * @param {Error} error
       */
      const handleError = (error) => {
        if (settled) return

        if (options.retry !== false &&
            attemptIndex < getMaxAttempts(options) &&
            isRetriableNetworkError(error)) {
          settled = true
          finalize()
          // Unref so a pending retry never keeps the host process alive past
          // its natural exit point; long-running apps still retry because the
          // event loop is held open by their own work.
          setTimeout(attempt, getRetryDelay(options, attemptIndex), attemptIndex + 1).unref?.()
        } else {
          complete(error)
        }
      }

      const req = client.request(options, (res) => onResponse(res, complete, handleError))

      req.once('close', finalize)
      req.once('timeout', finalize)
      req.once('error', handleError)

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
