'use strict'

// TODO: Add test with slow or unresponsive agent.
// TODO: Add telemetry for things like dropped requests, errors, etc.

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { canSendApiKey, parseUrl } = require('./url')
const docker = require('./docker')
const { httpAgent, httpsAgent } = require('./agents')
const { getHttpsProxyAgent } = require('./proxy')
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
 * @typedef {import('node:http').RequestOptions & {
 *   url?: string|URL|object,
 *   retry?: boolean,
 *   deferTimeoutAbort?: boolean,
 *   keepProcessAlive?: boolean
 * }} RequestOptions
 */

/**
 * @param {RequestOptions} options
 * @param {number} contentLength
 * @returns {RequestOptions}
 */
function prepareRequestOptions (options, contentLength) {
  const connectionOptions = { ...options }

  if (options.url) {
    const url = parseUrl(options.url)
    if (url.protocol === 'unix:') {
      if (options.protocol !== undefined) delete connectionOptions.protocol
      if (options.hostname !== undefined) delete connectionOptions.hostname
      if (options.host !== undefined) delete connectionOptions.host
      if (options.port !== undefined) delete connectionOptions.port
      connectionOptions.socketPath = url.pathname
    } else {
      if (options.socketPath !== undefined) delete connectionOptions.socketPath
      if (options.host !== undefined) delete connectionOptions.host
      connectionOptions.protocol = url.protocol
      connectionOptions.hostname = url.hostname
      connectionOptions.port = url.port
      if (!options.path) connectionOptions.path = url.path
    }
  }
  if (connectionOptions.protocol !== undefined &&
      connectionOptions.protocol !== 'http:' &&
      connectionOptions.protocol !== 'https:') {
    throw Object.assign(
      new TypeError(`Unsupported request protocol: ${connectionOptions.protocol}`),
      { code: 'ERR_INVALID_PROTOCOL' }
    )
  }

  const sourceHeaders = options.headers ?? {}
  const headers = { ...sourceHeaders }
  const isSecure = connectionOptions.protocol === 'https:'
  const canSendKey = canSendApiKey(connectionOptions.protocol, connectionOptions.hostname)
  let hasApiKey = sourceHeaders['dd-api-key'] !== undefined || sourceHeaders['DD-API-KEY'] !== undefined
  if (!hasApiKey && (isSecure || !canSendKey)) {
    for (const name of Object.keys(sourceHeaders)) {
      if (sourceHeaders[name] !== undefined && name.toLowerCase() === 'dd-api-key') {
        hasApiKey = true
        break
      }
    }
  }

  // Local agents proxy with their own key. Strip unsafe keys instead of dropping the request.
  if (hasApiKey && !canSendKey) {
    log.error(
      'Not sending the Datadog API key over a non-TLS connection to %s. Configure an https intake URL.',
      connectionOptions.hostname
    )
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'dd-api-key') delete headers[name]
    }
  }

  headers['Content-Length'] = contentLength
  docker.inject(headers)
  connectionOptions.headers = headers

  const directAgent = options.agent ?? (isSecure ? httpsAgent : httpAgent)
  connectionOptions.agent = hasApiKey && isSecure
    ? getHttpsProxyAgent(connectionOptions, directAgent)
    : directAgent

  return connectionOptions
}

/**
 * @param {Buffer|string|Readable|Array<Buffer|string>} data
 * @param {RequestOptions} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders, dropped?: boolean) => void} callback
 */
function request (data, options, callback) {
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
  let dataArray = data

  if (!Array.isArray(data)) {
    dataArray = [data]
  }
  const contentLength = byteLength(dataArray)
  let connectionOptions
  try {
    connectionOptions = prepareRequestOptions(options, contentLength)
  } catch (error) {
    callback(error)
    return
  }
  const client = connectionOptions.protocol === 'https:' ? https : http

  /**
   * @param {import('node:http').IncomingMessage} res
   * @param {(error: Error|null, result?: string|null, statusCode?: number,
   *   headers?: import('node:http').IncomingHttpHeaders) => void} complete
   * @param {(error: Error) => void} handleError
   */
  const onResponse = (res, complete, handleError) => {
    markEndpointReached(connectionOptions)

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
            connectionOptions.path,
            connectionOptions.url || connectionOptions.hostname || `http://localhost:${connectionOptions.port}`
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
    if (activeBufferSize + contentLength > maxActiveBufferSize) {
      const error = new log.NoTransmitError('Maximum active request buffer size reached: payload is discarded.')
      error.code = 'ERR_DD_REQUEST_BUFFER_FULL'
      log.debug(error.message)
      return callback(error, undefined, undefined, undefined, true)
    }

    activeBufferSize += contentLength

    legacyStorage.run({ noop: true }, () => {
      let finished = false
      let settled = false
      let timeoutImmediate
      const finalize = () => {
        if (finished) return
        finished = true
        activeBufferSize -= contentLength
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
        clearImmediate(timeoutImmediate)
        finalize()
        callback(error, result, statusCode, headers)
      }

      /**
       * @param {Error} error
       */
      const handleError = (error) => {
        if (settled) return
        clearImmediate(timeoutImmediate)

        if (connectionOptions.retry !== false &&
            attemptIndex < getMaxAttempts(connectionOptions) &&
            isRetriableNetworkError(error)) {
          settled = true
          finalize()
          // Unref so a pending retry never keeps the host process alive past
          // its natural exit point; long-running apps still retry because the
          // event loop is held open by their own work.
          setTimeout(attempt, getRetryDelay(connectionOptions, attemptIndex), attemptIndex + 1).unref?.()
        } else {
          complete(error)
        }
      }

      const req = client.request(connectionOptions, (res) => onResponse(res, complete, handleError))

      req.once('close', finalize)
      if (!connectionOptions.deferTimeoutAbort) req.once('timeout', finalize)
      req.once('error', handleError)

      const abortRequest = () => {
        if (settled) return
        try {
          if (typeof req.abort === 'function') {
            req.abort()
          } else {
            req.destroy()
          }
        } catch {
          // ignore
        }
      }

      req.setTimeout(timeout, () => {
        if (!connectionOptions.deferTimeoutAbort) {
          abortRequest()
          return
        }

        timeoutImmediate = setImmediate(() => {
          abortRequest()
          finalize()
        })
        if (!connectionOptions.keepProcessAlive) timeoutImmediate.unref?.()
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
