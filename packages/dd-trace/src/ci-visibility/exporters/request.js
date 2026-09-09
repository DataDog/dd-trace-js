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
const { MAX_REQUEST_BUFFERED_BYTES } = require('./limits')

const BACKPRESSURE_RETRY_MS = 50
const REQUEST_BUFFER_FULL_CODE = 'ERR_DD_REQUEST_BUFFER_FULL'

let bufferedBytes = 0
let backpressureTimer
let backpressureTimerDue
let ownedBackpressureWaiters = 0

/**
 * @typedef {object} BackpressureWaiter
 * @property {(attemptIndex: number) => void} attempt
 * @property {number} attemptIndex
 * @property {number} due
 * @property {boolean} keepProcessAlive
 */

/** @type {Set<BackpressureWaiter>} */
const backpressureWaiters = new Set()

/**
 * Keeps the shared polling timer alive only while an owned request is waiting.
 *
 * @returns {void}
 */
function updateBackpressureTimerRef () {
  if (ownedBackpressureWaiters > 0) backpressureTimer.ref?.()
  else backpressureTimer.unref?.()
}

/**
 * Schedules the next shared backpressure poll.
 *
 * @param {number} due
 * @returns {void}
 */
function setBackpressureTimer (due) {
  clearTimeout(backpressureTimer)
  backpressureTimerDue = due
  backpressureTimer = setTimeout(runBackpressureWaiters, Math.max(0, due - Date.now()))
  updateBackpressureTimerRef()
}

/**
 * Adds a request to the shared backpressure poll.
 *
 * @param {BackpressureWaiter} waiter
 * @param {number} delay
 * @param {number} attemptIndex
 * @returns {void}
 */
function scheduleBackpressureRetry (waiter, delay, attemptIndex) {
  waiter.attemptIndex = attemptIndex
  waiter.due = Date.now() + delay

  backpressureWaiters.add(waiter)
  if (waiter.keepProcessAlive) ownedBackpressureWaiters++

  if (backpressureTimer === undefined || waiter.due < backpressureTimerDue) {
    setBackpressureTimer(waiter.due)
  } else {
    updateBackpressureTimerRef()
  }
}

/**
 * Removes a settled request from the shared backpressure poll.
 *
 * @param {BackpressureWaiter} waiter
 * @returns {void}
 */
function removeBackpressureWaiter (waiter) {
  if (!backpressureWaiters.delete(waiter)) return
  if (waiter.keepProcessAlive) ownedBackpressureWaiters--

  if (backpressureWaiters.size === 0) {
    clearTimeout(backpressureTimer)
    backpressureTimer = undefined
    backpressureTimerDue = undefined
  } else {
    updateBackpressureTimerRef()
  }
}

/**
 * Retries every request whose shared backpressure delay has elapsed.
 *
 * @returns {void}
 */
function runBackpressureWaiters () {
  const now = Date.now()
  const ready = []
  backpressureTimer = undefined
  backpressureTimerDue = undefined

  for (const waiter of backpressureWaiters) {
    if (waiter.due > now) continue
    backpressureWaiters.delete(waiter)
    if (waiter.keepProcessAlive) ownedBackpressureWaiters--
    ready.push(waiter)
  }

  let nextDue = Infinity
  for (const waiter of backpressureWaiters) {
    if (waiter.due < nextDue) nextDue = waiter.due
  }
  if (nextDue !== Infinity) setBackpressureTimer(nextDue)

  for (const waiter of ready) waiter.attempt(waiter.attemptIndex)
}

/**
 * @param {Buffer|string|Array<Buffer|string>|(() => Readable)} data
 * @returns {number}
 */
function getPayloadSize (data) {
  // Factory-backed payloads are streamed by their custom transport and enforce their own concurrency limit.
  if (typeof data === 'function') return 0
  if (!Array.isArray(data)) return Buffer.byteLength(data)

  let size = 0
  for (const chunk of data) size += Buffer.byteLength(chunk)
  return size
}

/**
 * @returns {Error & { code: string }}
 */
function createQueueFullError () {
  const error = new Error('Test Optimization request queue reached its payload limit')
  error.code = 'ERR_DD_TEST_OPTIMIZATION_QUEUE_FULL'
  return error
}

/**
 * @returns {Error & { code: string }}
 */
function createBackpressureTimeoutError () {
  const error = new Error('Test Optimization request remained blocked by exporter backpressure')
  error.code = 'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT'
  return error
}

/**
 * @returns {Error & { code: string }}
 */
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
 * @param {(error: Error|null, data?: Buffer, payloadSize?: number) => void} callback
 * @returns {void}
 */
function bufferReadable (data, signal, callback) {
  const chunks = []
  let payloadSize = 0
  let settled = false

  const release = () => {
    bufferedBytes -= payloadSize
    payloadSize = 0
  }
  const cleanup = (keepErrorListener = false) => {
    data.removeListener('data', onData)
    data.removeListener('end', onEnd)
    if (!keepErrorListener) data.removeListener('error', onError)
    signal?.removeEventListener('abort', onAbort)
  }
  const onData = chunk => {
    const chunkSize = Buffer.byteLength(chunk)
    if (chunkSize > MAX_REQUEST_BUFFERED_BYTES - bufferedBytes) {
      settled = true
      cleanup(true)
      release()
      data.once('close', () => data.removeListener('error', onError))
      data.destroy()
      callback(createQueueFullError())
      return
    }
    bufferedBytes += chunkSize
    payloadSize += chunkSize
    chunks.push(chunk)
  }
  const onEnd = () => {
    if (settled) return
    settled = true
    cleanup()
    callback(null, chunks, payloadSize)
  }
  const onError = error => {
    if (settled) return
    settled = true
    cleanup()
    release()
    callback(error)
  }
  const onAbort = () => {
    if (settled) return
    settled = true
    cleanup(true)
    release()
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
    bufferReadable(data, signal, (error, bufferedData, payloadSize) => {
      if (error) return callback(error)
      requestBuffered(bufferedData, options, callback, payloadSize)
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
 * @param {number} [reservedPayloadSize]
 * @returns {void}
 */
function requestBuffered (data, options, callback, reservedPayloadSize) {
  const { signal } = options
  const transport = options.transport || commonRequest
  const timeout = options.timeout || 2000
  const payloadSize = reservedPayloadSize ?? getPayloadSize(data)
  let retryTimer
  let attemptTimer
  let attemptTimerImmediate
  let attemptController
  let settled = false
  let lastError
  let waitingForBackpressure = false

  const backpressureWaiter = {
    attempt,
    attemptIndex: 1,
    due: 0,
    keepProcessAlive: options.keepProcessAlive === true,
  }

  if (reservedPayloadSize === undefined) {
    if (payloadSize > MAX_REQUEST_BUFFERED_BYTES - bufferedBytes) {
      callback(createQueueFullError())
      return
    }
    bufferedBytes += payloadSize
  }

  const complete = (error, result, statusCode, headers) => {
    if (settled) return
    settled = true
    clearTimeout(retryTimer)
    clearTimeout(attemptTimer)
    clearImmediate(attemptTimerImmediate)
    removeBackpressureWaiter(backpressureWaiter)
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

    try {
      complete(error, null, error.status)
    } finally {
      controller?.abort(abortError)
    }
  }

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) return onAbort()

  /**
   * @param {number} attemptIndex
   * @returns {void}
   */
  function attempt (attemptIndex) {
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
        error.code = FINAL_FLUSH_TIMEOUT_CODE
        complete(error)
      }
      return
    }

    if (!transport.writable) {
      waitingForBackpressure = true
      scheduleBackpressureRetry(
        backpressureWaiter,
        Math.min(BACKPRESSURE_RETRY_MS, remaining),
        attemptIndex
      )
      return
    }
    waitingForBackpressure = false

    const attemptOptions = {
      ...options,
      deferTimeoutAbort: true,
      headers: options.headers ? { ...options.headers } : undefined,
      retry: false,
    }
    delete attemptOptions.transport
    if (deadline !== undefined) attemptOptions.timeout = Math.max(1, Math.min(timeout, remaining))

    let attemptData
    try {
      attemptData = typeof data === 'function' ? data() : data
    } catch (error) {
      complete(error)
      return
    }

    const controller = new AbortController()
    const attemptTimeout = attemptOptions.timeout || timeout
    let attemptTimedOut = false

    attemptController = controller
    attemptOptions.signal = controller.signal
    if (options.timeoutFromCreation !== false) {
      attemptTimer = setTimeout(() => {
        // Let a response that became ready while the event loop was blocked win before aborting it.
        attemptTimerImmediate = setImmediate(() => {
          if (settled || attemptController !== controller) return
          attemptTimedOut = true
          controller.abort(createRequestTimeoutError())
        })
        if (!options.keepProcessAlive) attemptTimerImmediate.unref?.()
      }, attemptTimeout)
      if (!options.keepProcessAlive) attemptTimer.unref?.()
    }

    transport(attemptData, attemptOptions, (error, result, statusCode, headers) => {
      clearTimeout(attemptTimer)
      clearImmediate(attemptTimerImmediate)
      if (attemptController === controller) attemptController = undefined
      if (settled) return
      if (!error) {
        complete(null, result, statusCode, headers)
        return
      }

      if (error.code === REQUEST_BUFFER_FULL_CODE) {
        waitingForBackpressure = true
        scheduleBackpressureRetry(
          backpressureWaiter,
          Math.min(BACKPRESSURE_RETRY_MS, remaining),
          attemptIndex
        )
        return
      }

      const requestError = attemptTimedOut ? createRequestTimeoutError() : error
      lastError = requestError

      const responseStatus = statusCode ?? error.status
      const isUnknownNetworkError = responseStatus === undefined && error.code === undefined
      const isRetriableError = error.retryable !== false &&
        (attemptTimedOut || isRetriableNetworkError(error) || isUnknownNetworkError ||
          isRetriableHttpStatusCode(responseStatus))
      const retryUntilDeadline = options.deadline !== undefined && options.retryUntilDeadline !== false
      const reachedAttemptLimit = !retryUntilDeadline && attemptIndex >= getMaxAttempts(attemptOptions)
      const reachedUnknownNetworkAttemptLimit = isUnknownNetworkError && attemptIndex >= 2
      if (
        options.retry === false ||
        !isRetriableError ||
        reachedAttemptLimit ||
        reachedUnknownNetworkAttemptLimit
      ) {
        complete(requestError, result, statusCode, headers)
        return
      }

      let retryDelay
      if (responseStatus === 429) {
        const resetDelay = getRateLimitResetDelay(headers)
        if (Number.isFinite(resetDelay)) {
          if (options.deadline !== undefined) {
            const retryRemaining = options.deadline - Date.now()
            if (resetDelay >= retryRemaining) {
              complete(requestError, result, statusCode, headers)
              return
            }
          } else if (resetDelay > RATE_LIMIT_MAX_WAIT_MS) {
            complete(requestError, result, statusCode, headers)
            return
          }
          retryDelay = resetDelay
        }
      }

      let delay = retryDelay ?? getRetryDelay(attemptOptions, attemptIndex)
      if (options.deadline !== undefined && retryDelay === undefined) {
        const retryRemaining = options.deadline - Date.now()
        if (retryRemaining <= 0) {
          complete(requestError, result, statusCode, headers)
          return
        }
        const retryAttemptTimeout = timeout < retryRemaining ? timeout : Math.ceil(retryRemaining / 2)
        delay = Math.min(delay, Math.max(0, retryRemaining - retryAttemptTimeout))
      }

      retryTimer = setTimeout(attempt, delay, attemptIndex + 1)
      if (!options.keepProcessAlive) retryTimer.unref?.()
    })
  }

  attempt(1)
}

module.exports = request
