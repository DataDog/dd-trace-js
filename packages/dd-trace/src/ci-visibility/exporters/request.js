'use strict'

const { Readable } = require('node:stream')

const commonRequest = require('../../exporters/common/request')
const { parseUrl } = require('../../exporters/common/url')
const {
  RATE_LIMIT_MAX_WAIT_MS,
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
} = require('../../exporters/common/retry')
const log = require('../../log')
const { getRateLimitResetDelay } = require('../requests/rate-limit')

/**
 * Captures the dedicated agent pressure for the request origin.
 *
 * @param {object} options
 * @returns {{ activeSockets: number|null, queuedRequests: number|null, maxSockets: number|string|null }}
 */
function getAgentPressure (options) {
  const { agent } = options
  if (!agent?.getName) {
    return { activeSockets: null, queuedRequests: null, maxSockets: null }
  }

  try {
    const connectionOptions = options.url ? { ...options, ...parseUrl(options.url) } : options
    const name = agent.getName(connectionOptions)
    const activeSockets = agent.sockets?.[name]?.length || 0
    const queuedRequests = agent.requests?.[name]?.length || 0
    const maxSockets = Number.isFinite(agent.maxSockets) ? agent.maxSockets : String(agent.maxSockets)

    return { activeSockets, queuedRequests, maxSockets }
  } catch {
    return { activeSockets: null, queuedRequests: null, maxSockets: null }
  }
}

/**
 * Records a failed Test Optimization request attempt without exposing intake URLs or headers.
 *
 * @param {Error} error
 * @param {number} attemptNumber
 * @param {object} options
 * @param {number} [statusCode]
 * @param {{ activeSockets: number|null, queuedRequests: number|null, maxSockets: number|string|null,
 *   queuedWhenSubmitted?: boolean|null }} [pressure]
 * @returns {void}
 */
function logAttemptFailure (error, attemptNumber, options, statusCode, pressure = getAgentPressure(options)) {
  const remainingDeadlineMs = options.deadline === undefined ? null : Math.max(0, options.deadline - Date.now())
  const queuedWhenSubmitted = pressure.queuedWhenSubmitted ?? (
    pressure.queuedRequests === null || pressure.activeSockets === null || pressure.maxSockets === null
      ? null
      : pressure.queuedRequests > 0 || pressure.activeSockets >= pressure.maxSockets
  )
  const diagnostic = {
    attemptNumber,
    code: error.code || null,
    statusCode: statusCode ?? error.status ?? null,
    remainingDeadlineMs,
    queuedWhenSubmitted,
    activeSockets: pressure.activeSockets,
    queuedRequests: pressure.queuedRequests,
    maxSockets: pressure.maxSockets,
    endpoint: options.path || null,
  }

  log.error('Test Optimization request attempt failed: %s', JSON.stringify(diagnostic))
}

/**
 * @param {AbortSignal} signal
 * @returns {Error}
 */
function getAbortError (signal) {
  return signal.reason || Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' })
}

/**
 * Buffers a stream once so a Test Optimization exporter request can safely retry it.
 *
 * @param {Readable} data
 * @param {AbortSignal} [signal]
 * @param {(error: Error|null, data?: Buffer) => void} callback
 * @returns {void}
 */
function bufferReadable (data, signal, callback) {
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
    callback(null, Buffer.concat(chunks))
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
}

/**
 * Sends Test Optimization exporter data through the common single-attempt transport while
 * keeping retry and finalization policy scoped to Test Optimization.
 *
 * @param {Buffer|string|Readable|Array<Buffer|string>} data
 * @param {object} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
 * @returns {void}
 */
function request (data, options, callback) {
  const { signal } = options
  if (signal?.aborted) return callback(getAbortError(signal))

  if (data instanceof Readable) {
    bufferReadable(data, signal, (error, bufferedData) => {
      if (error) return callback(error)
      requestBuffered(bufferedData, options, callback)
    })
    return
  }

  requestBuffered(data, options, callback)
}

/**
 * Applies the Test Optimization retry policy to replayable request data.
 *
 * @param {Buffer|string|Array<Buffer|string>} data
 * @param {object} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
 * @returns {void}
 */
function requestBuffered (data, options, callback) {
  const { signal } = options
  const timeout = options.timeout || 2000
  let currentAttemptNumber = 1
  let currentAttemptPressure
  let retryTimer
  let settled = false

  const complete = (error, result, statusCode, headers) => {
    if (settled) return
    settled = true
    clearTimeout(retryTimer)
    signal?.removeEventListener('abort', onAbort)
    callback(error, result, statusCode, headers)
  }
  const onAbort = () => {
    const error = getAbortError(signal)
    logAttemptFailure(error, currentAttemptNumber, options, undefined, currentAttemptPressure)
    complete(error)
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) return onAbort()

  /** @param {number} attemptIndex */
  const attempt = attemptIndex => {
    if (settled) return
    if (signal?.aborted) return onAbort()

    currentAttemptNumber = attemptIndex
    currentAttemptPressure = undefined

    const deadline = options.deadline
    const remaining = deadline === undefined ? Infinity : deadline - Date.now()
    if (remaining <= 0) {
      const error = new Error('Test Optimization request reached its finalization deadline')
      error.code = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'
      logAttemptFailure(error, attemptIndex, options)
      complete(error)
      return
    }

    if (deadline !== undefined && !commonRequest.writable) {
      retryTimer = setTimeout(attempt, Math.min(50, remaining), attemptIndex)
      retryTimer.unref?.()
      return
    }

    const attemptOptions = {
      ...options,
      headers: options.headers ? { ...options.headers } : undefined,
      retry: false,
    }
    if (deadline !== undefined) attemptOptions.timeout = Math.max(1, Math.min(timeout, remaining))

    const pressureBeforeSubmission = getAgentPressure(attemptOptions)
    currentAttemptPressure = {
      ...pressureBeforeSubmission,
      queuedWhenSubmitted: pressureBeforeSubmission.queuedRequests === null ||
        pressureBeforeSubmission.activeSockets === null || pressureBeforeSubmission.maxSockets === null
        ? null
        : pressureBeforeSubmission.queuedRequests > 0 ||
          pressureBeforeSubmission.activeSockets >= pressureBeforeSubmission.maxSockets,
    }

    commonRequest(data, attemptOptions, (error, result, statusCode, headers) => {
      if (settled) return
      if (!error) {
        complete(null, result, statusCode, headers)
        return
      }

      const responseStatus = statusCode ?? error.status
      logAttemptFailure(error, attemptIndex, options, responseStatus, currentAttemptPressure)
      const isRetriableHttpError = options.deadline !== undefined &&
        (responseStatus === 429 || responseStatus >= 500)
      if (options.retry === false || (attemptIndex >= getMaxAttempts(attemptOptions) &&
        (isRetriableNetworkError(error) || isRetriableHttpError))) {
        complete(error, result, statusCode, headers)
        return
      }

      if (!isRetriableNetworkError(error) && !isRetriableHttpError) {
        complete(error, result, statusCode, headers)
        return
      }

      let retryDelay
      if (responseStatus === 429) {
        const resetDelay = getRateLimitResetDelay(headers)
        if (Number.isFinite(resetDelay)) {
          const retryRemaining = options.deadline - Date.now()
          if (resetDelay > RATE_LIMIT_MAX_WAIT_MS || resetDelay >= retryRemaining) {
            complete(error, result, statusCode, headers)
            return
          }
          retryDelay = resetDelay
        }
      }

      let delay = retryDelay ?? getRetryDelay(attemptOptions, attemptIndex)
      if (options.deadline !== undefined && retryDelay === undefined) {
        const retryRemaining = options.deadline - Date.now()
        if (retryRemaining <= 0) {
          complete(error, result, statusCode, headers)
          return
        }
        const retryAttemptTimeout = timeout < retryRemaining ? timeout : Math.ceil(retryRemaining / 2)
        delay = Math.min(delay, Math.max(0, retryRemaining - retryAttemptTimeout))
      }

      retryTimer = setTimeout(attempt, delay, attemptIndex + 1)
      retryTimer.unref?.()
    })

    const pressureAfterSubmission = getAgentPressure(attemptOptions)
    if (currentAttemptPressure.queuedRequests !== null && pressureAfterSubmission.queuedRequests !== null) {
      currentAttemptPressure.queuedWhenSubmitted ||=
        pressureAfterSubmission.queuedRequests > currentAttemptPressure.queuedRequests
    }
    currentAttemptPressure.activeSockets = pressureAfterSubmission.activeSockets
    currentAttemptPressure.queuedRequests = pressureAfterSubmission.queuedRequests
  }

  attempt(1)
}

module.exports = request
