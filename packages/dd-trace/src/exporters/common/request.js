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
const {
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
  markEndpointReached,
} = require('./retry')

const legacyStorage = storage('legacy')

const maxActiveBufferSize = 1024 * 1024 * 64

let activeBufferSize = 0

function createIdentityRefreshError () {
  const error = new log.NoTransmitError('Pending request retry cancelled on identity refresh.')
  error.code = 'ERR_DD_IDENTITY_REFRESH'
  return error
}

/**
 * An encoder reset cannot reach a payload already handed to request(). On a MicroVM clone resume,
 * this controller cancels retry timers and active requests so stale pre-refresh buffers cannot be
 * sent under the clone's new runtime ID. Only MicroVM-aware writers pass this controller, so
 * ordinary non-MicroVM requests keep their existing lifecycle.
 * @returns {{ generation: number, pendingRetryTimers: Set<object>,
 *   activeRequests: Set<() => void>, reset: () => void }}
 */
function createResetController () {
  const controller = {
    generation: 0,
    pendingRetryTimers: new Set(),
    activeRequests: new Set(),
    reset () {
      // Identity-refresh handlers call reset() when a MicroVM clone starts. Active requests must be
      // aborted in addition to clearing buffers because they may still be connecting and send later.
      controller.generation++

      for (const retry of controller.pendingRetryTimers) {
        retry.cancel()
      }
      controller.pendingRetryTimers.clear()

      const activeRequests = [...controller.activeRequests]
      controller.activeRequests.clear()
      for (const cancel of activeRequests) {
        cancel()
      }
    },
  }

  return controller
}

/**
 * @param {Buffer|string|Readable|Array<Buffer|string>} data
 * @param {object} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders, dropped?: boolean) => void} callback
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
  if (hasApiKey && !canSendApiKey(options.protocol, options.hostname)) {
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
  const contentLength = byteLength(dataArray)
  options.headers['Content-Length'] = contentLength
  // Captured once per logical request; if the writer resets before a retry fires, this Buffer may
  // carry the old runtime-id and must be discarded instead of sent under the clone's identity.
  const resetController = options.resetController
  const capturedRequestGeneration = resetController?.generation

  docker.inject(options.headers)

  const connectionOptions = {
    ...options,
    agent: options.agent ?? (isSecure ? httpsAgent : httpAgent),
  }
  delete connectionOptions.resetController

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
      let cancelActiveRequest
      const finalize = () => {
        if (finished) return
        finished = true
        activeBufferSize -= contentLength
        resetController?.activeRequests.delete(cancelActiveRequest)
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

        if (resetController && capturedRequestGeneration !== resetController.generation) {
          complete(createIdentityRefreshError())
          return
        }

        if (options.retry !== false &&
            attemptIndex < getMaxAttempts(options) &&
            isRetriableNetworkError(error)) {
          settled = true
          finalize()
          // Unref so a pending retry never keeps the host process alive past
          // its natural exit point; long-running apps still retry because the
          // event loop is held open by their own work.
          const retry = {
            cancel () {
              clearTimeout(timer)
              callback(createIdentityRefreshError())
            },
          }
          const timer = setTimeout(() => {
            resetController?.pendingRetryTimers.delete(retry)
            if (resetController && capturedRequestGeneration !== resetController.generation) {
              callback(createIdentityRefreshError())
              return
            }
            attempt(attemptIndex + 1)
          }, getRetryDelay(options, attemptIndex))
          resetController?.pendingRetryTimers.add(retry)
          timer.unref?.()
        } else {
          complete(error)
        }
      }

      const req = client.request(connectionOptions, (res) => onResponse(res, complete, handleError))

      req.once('close', finalize)
      if (!options.deferTimeoutAbort) req.once('timeout', finalize)
      req.once('error', handleError)

      const abortRequest = (force = false) => {
        if (settled && !force) return
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

      if (resetController) {
        // Only reset-aware writers track active requests; non-MicroVM writers do not pass a
        // controller, so their request path has no additional tracking or cancellation work.
        cancelActiveRequest = () => {
          if (settled) return
          settled = true
          abortRequest(true)
          clearImmediate(timeoutImmediate)
          finalize()
          callback(createIdentityRefreshError())
        }
        resetController.activeRequests.add(cancelActiveRequest)
      }

      req.setTimeout(timeout, () => {
        if (!options.deferTimeoutAbort) {
          abortRequest()
          return
        }

        timeoutImmediate = setImmediate(() => {
          abortRequest()
          finalize()
        })
        if (!options.keepProcessAlive) timeoutImmediate.unref?.()
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

request.createResetController = createResetController

module.exports = request
