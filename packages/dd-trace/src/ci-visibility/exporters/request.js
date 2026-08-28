'use strict'

const { Readable } = require('node:stream')

const commonRequest = require('../../exporters/common/request')
const {
  RATE_LIMIT_MAX_WAIT_MS,
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
} = require('../../exporters/common/retry')
const { FINAL_FLUSH_TIMEOUT_CODE } = require('../final-flush')
const { getRateLimitResetDelay } = require('../requests/rate-limit')

const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
const BACKPRESSURE_RETRY_MS = 50

let bufferedBytes = 0

function getPayloadSize (data) {
  if (!Array.isArray(data)) return Buffer.byteLength(data)

  let size = 0
  for (const chunk of data) size += Buffer.byteLength(chunk)
  return size
}

function createQueueFullError () {
  const error = new Error('Test Optimization request queue reached its payload limit')
  error.code = 'ERR_DD_TEST_OPTIMIZATION_QUEUE_FULL'
  return error
}

function createBackpressureTimeoutError () {
  const error = new Error('Test Optimization request remained blocked by exporter backpressure')
  error.code = 'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT'
  return error
}

function createRequestTimeoutError () {
  const error = new Error('Test Optimization transport attempt timed out')
  error.code = 'ERR_DD_TEST_OPTIMIZATION_REQUEST_TIMEOUT'
  return error
}

/**
 * @param {number} statusCode
 * @returns {boolean}
 */
function isRetriableHttpStatusCode (statusCode) {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)
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
  const payloadSize = getPayloadSize(data)
  let retryTimer
  let attemptController
  let settled = false
  let lastError
  let waitingForBackpressure = false

  if (payloadSize > MAX_BUFFERED_BYTES - bufferedBytes) {
    callback(createQueueFullError())
    return
  }
  bufferedBytes += payloadSize

  const complete = (error, result, statusCode, headers) => {
    if (settled) return
    settled = true
    clearTimeout(retryTimer)
    signal?.removeEventListener('abort', onAbort)
    bufferedBytes -= payloadSize
    callback(error, result, statusCode, headers)
  }
  const onAbort = () => {
    const abortError = getAbortError(signal)
    const controller = attemptController
    let error = lastError || abortError

    if (abortError.code === FINAL_FLUSH_TIMEOUT_CODE) {
      if (waitingForBackpressure) error = createBackpressureTimeoutError()
      else if (controller) error = createRequestTimeoutError()
    }

    complete(error, null, error.status)
    controller?.abort(abortError)
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) return onAbort()

  /** @param {number} attemptIndex */
  const attempt = attemptIndex => {
    if (settled) return
    if (signal?.aborted) return onAbort()

    const deadline = options.deadline
    const remaining = deadline === undefined ? Infinity : deadline - Date.now()
    if (remaining <= 0) {
      if (waitingForBackpressure) {
        complete(createBackpressureTimeoutError())
      } else if (lastError) {
        complete(lastError, null, lastError.status)
      } else {
        const error = new Error('Test Optimization request reached its finalization deadline')
        error.code = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'
        complete(error)
      }
      return
    }

    if (!commonRequest.writable) {
      waitingForBackpressure = true
      retryTimer = setTimeout(attempt, Math.min(BACKPRESSURE_RETRY_MS, remaining), attemptIndex)
      retryTimer.unref?.()
      return
    }
    waitingForBackpressure = false

    const attemptOptions = {
      ...options,
      headers: options.headers ? { ...options.headers } : undefined,
      retry: false,
    }
    if (deadline !== undefined) attemptOptions.timeout = Math.max(1, Math.min(timeout, remaining))

    const controller = new AbortController()
    attemptController = controller
    attemptOptions.signal = controller.signal

    commonRequest(data, attemptOptions, (error, result, statusCode, headers) => {
      if (attemptController === controller) attemptController = undefined
      if (settled) return
      if (!error) {
        complete(null, result, statusCode, headers)
        return
      }

      lastError = error

      const responseStatus = statusCode ?? error.status
      const isRetriableHttpError = isRetriableHttpStatusCode(responseStatus)
      const isRetriableError = isRetriableNetworkError(error) || isRetriableHttpError
      const reachedAttemptLimit = attemptIndex >= getMaxAttempts(attemptOptions)
      if (options.retry === false || !isRetriableError || reachedAttemptLimit) {
        complete(error, result, statusCode, headers)
        return
      }

      let retryDelay
      if (responseStatus === 429) {
        const resetDelay = getRateLimitResetDelay(headers)
        if (Number.isFinite(resetDelay)) {
          if (options.deadline !== undefined) {
            const retryRemaining = options.deadline - Date.now()
            if (resetDelay >= retryRemaining) {
              complete(error, result, statusCode, headers)
              return
            }
          } else if (resetDelay > RATE_LIMIT_MAX_WAIT_MS) {
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
  }

  attempt(1)
}

module.exports = request
