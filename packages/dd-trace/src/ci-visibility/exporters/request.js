'use strict'

const { Readable } = require('node:stream')

const commonRequest = require('../../exporters/common/request')
const {
  RATE_LIMIT_MAX_WAIT_MS,
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
} = require('../../exporters/common/retry')
const { getRateLimitResetDelay } = require('../requests/rate-limit')

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
 * @param {Buffer|string|Readable|Array<Buffer|string>|(() => Readable)} data
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
 * @param {Buffer|string|Array<Buffer|string>|(() => Readable)} data
 * @param {object} options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
 * @returns {void}
 */
function requestBuffered (data, options, callback) {
  const { signal } = options
  const timeout = options.timeout || 2000
  let retryTimer
  let settled = false

  const complete = (error, result, statusCode, headers) => {
    if (settled) return
    settled = true
    clearTimeout(retryTimer)
    signal?.removeEventListener('abort', onAbort)
    callback(error, result, statusCode, headers)
  }
  const onAbort = () => complete(getAbortError(signal))

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) return onAbort()

  /** @param {number} attemptIndex */
  const attempt = attemptIndex => {
    if (settled) return
    if (signal?.aborted) return onAbort()

    const deadline = options.deadline
    const remaining = deadline === undefined ? Infinity : deadline - Date.now()
    if (remaining <= 0) {
      const error = new Error('Test Optimization request reached its finalization deadline')
      error.code = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'
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

    let attemptData
    try {
      attemptData = typeof data === 'function' ? data() : data
    } catch (error) {
      complete(error)
      return
    }

    commonRequest(attemptData, attemptOptions, (error, result, statusCode, headers) => {
      if (settled) return
      if (!error) {
        complete(null, result, statusCode, headers)
        return
      }

      const responseStatus = statusCode ?? error.status
      const isRetriableError = isRetriableNetworkError(error) || isRetriableHttpStatusCode(responseStatus)
      const retryUntilDeadline = options.deadline !== undefined && options.retryUntilDeadline !== false
      const reachedAttemptLimit = !retryUntilDeadline && attemptIndex >= getMaxAttempts(attemptOptions)
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
