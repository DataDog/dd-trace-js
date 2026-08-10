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
  RATE_LIMIT_MAX_WAIT_MS,
  getMaxAttempts,
  getRateLimitResetDelay,
  getRetryDelay,
  isRetriableNetworkError,
  markEndpointReached,
} = require('./retry')

const legacyStorage = storage('legacy')

const maxActiveBufferSize = 1024 * 1024 * 64

let activeBufferSize = 0

/**
 * @param {AbortSignal} signal
 * @returns {Error}
 */
function getAbortError (signal) {
  return signal.reason || Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' })
}

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

  const { signal } = options
  if (signal?.aborted) return callback(getAbortError(signal))

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
    let settled = false

    const cleanup = (keepErrorListener = false) => {
      data.removeListener('data', onData)
      data.removeListener('end', onEnd)
      if (!keepErrorListener) data.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onData = chunk => chunks.push(chunk)
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      request(Buffer.concat(chunks), options, callback)
    }
    const onError = error => {
      if (settled) return
      settled = true
      cleanup()
      callback(error)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup(true)
      data.once('close', () => data.removeListener('error', onError))
      data.destroy()
      callback(getAbortError(signal))
    }

    data.on('data', onData)
    data.once('end', onEnd)
    data.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

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
   * @param {(error: Error, statusCode?: number,
   *   headers?: import('node:http').IncomingHttpHeaders) => void} handleError
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

        if (options.retryOnHttpError) {
          handleError(error, res.statusCode, res.headers)
        } else {
          complete(error, null, res.statusCode, res.headers)
        }
      }
    })
  }

  // Retries always run via setTimeout so the AsyncLocalStorage store survives
  // the gap before socket.connect(); ALS.run() does not call ALS.enterWith()
  // outside AsyncContextFrame, so a synchronous re-entry would lose the store.
  /** @param {number} attemptIndex */
  const attempt = attemptIndex => {
    if (signal?.aborted) return callback(getAbortError(signal))

    if (!request.writable) {
      if (options.deadline !== undefined && Date.now() < options.deadline) {
        const delay = Math.min(50, options.deadline - Date.now())
        setTimeout(attempt, delay, attemptIndex).unref?.()
        return
      }
      log.debug('Maximum number of active requests reached: payload is discarded.')
      if (options.deadline === undefined) return callback(null)

      const error = new Error('Maximum number of active requests reached before the request deadline')
      error.code = 'ERR_DD_REQUEST_BUFFER_FULL'
      return callback(error)
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
       * @param {number} [statusCode]
       * @param {import('node:http').IncomingHttpHeaders} [headers]
       */
      const handleError = (error, statusCode, headers) => {
        if (settled) return

        const isRetriableHttpError = options.retryOnHttpError === true &&
          (error.status === 429 || error.status >= 500)
        let retryDelay
        if (isRetriableHttpError && error.status === 429) {
          const resetDelay = getRateLimitResetDelay(headers)
          if (Number.isFinite(resetDelay)) {
            const remaining = options.deadline === undefined ? Infinity : options.deadline - Date.now()
            if (resetDelay > RATE_LIMIT_MAX_WAIT_MS || resetDelay >= remaining) {
              complete(error, null, statusCode, headers)
              return
            }
            retryDelay = resetDelay
          }
        }
        if (options.retry !== false &&
            attemptIndex < getMaxAttempts(options) &&
            (isRetriableNetworkError(error) || isRetriableHttpError)) {
          let delay = retryDelay ?? getRetryDelay(options, attemptIndex)
          if (options.deadline !== undefined && retryDelay === undefined) {
            const remaining = options.deadline - Date.now()
            if (remaining <= 0) {
              complete(error, null, statusCode, headers)
              return
            }
            delay = Math.min(delay, Math.max(0, remaining - timeout))
          }
          settled = true
          finalize()
          // Unref so a pending retry never keeps the host process alive past
          // its natural exit point; long-running apps still retry because the
          // event loop is held open by their own work.
          setTimeout(attempt, delay, attemptIndex + 1).unref?.()
        } else {
          complete(error, null, statusCode, headers)
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
