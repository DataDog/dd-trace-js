'use strict'

const log = require('./log')

/**
 * @typedef {(error?: unknown) => void} FlushDone
 * @typedef {(done: FlushDone) => void | boolean | (() => void) | Promise<void>} Flusher
 */

/** @type {Map<string, Flusher>} */
const flushers = new Map()
/** @type {Map<string, Flusher>} */
const postTraceFlushers = new Map()
/** @type {Map<string, Flusher>} */
const traceFlushers = new Map()

/**
 * Removes a configured pipeline from lifecycle flushing.
 *
 * @param {string} name
 * @returns {void}
 */
function unregisterFlusher (name) {
  flushers.delete(name)
  postTraceFlushers.delete(name)
  traceFlushers.delete(name)
}

/**
 * Registers or replaces a configured pipeline for lifecycle flushing.
 *
 * @param {string} name
 * @param {Flusher} flusher
 * @param {{ afterTrace?: boolean, trace?: boolean }} [options]
 * @returns {() => void} Removes this pipeline unless it has been replaced.
 */
function registerFlusher (name, flusher, options) {
  unregisterFlusher(name)
  const target = options?.trace ? traceFlushers : options?.afterTrace ? postTraceFlushers : flushers
  target.set(name, flusher)
  return () => {
    if (target.get(name) === flusher) target.delete(name)
  }
}

/**
 * Flushes every configured telemetry pipeline.
 *
 * @param {() => void} [done]
 * @param {{ timeout?: number }} [options]
 */
function flushAll (done, options) {
  const currentFlushers = [...flushers.values()]
  const currentPostTraceFlushers = [...postTraceFlushers.values()]
  const currentTraceFlushers = [...traceFlushers.values()]
  let pending = currentFlushers.length + currentPostTraceFlushers.length + currentTraceFlushers.length
  /** @type {Array<(() => void)|undefined>} */
  const cancellations = []
  let completed = false
  let timeout
  let tracesPending = currentTraceFlushers.length

  /** @param {boolean} [cancelPending] */
  const finish = (cancelPending) => {
    if (completed) return
    completed = true
    clearTimeout(timeout)
    if (cancelPending) {
      for (const cancel of cancellations) {
        if (!cancel) continue
        try {
          cancel()
        } catch (error) {
          log.error('Error cancelling telemetry flush: %s', error)
        }
      }
    }
    done?.()
  }
  const complete = () => {
    if (--pending === 0) finish()
  }

  if (pending === 0) return finish()
  if (options?.timeout) {
    timeout = setTimeout(() => {
      log.warn('Timed out waiting for telemetry flush after %dms', options.timeout)
      finish(true)
    }, options.timeout)
  }

  /**
   * @param {Flusher} flusher
   * @param {() => void} [afterFlushed]
   */
  const flush = (flusher, afterFlushed) => {
    let flushed = false
    let cancellationIndex
    /** @param {unknown} [error] */
    const onFlushed = error => {
      if (flushed || completed) return
      flushed = true
      if (cancellationIndex !== undefined) cancellations[cancellationIndex] = undefined
      if (error !== undefined && error !== null) {
        log.error('Error flushing telemetry pipeline: %s', error)
      }
      try {
        afterFlushed?.()
      } finally {
        complete()
      }
    }
    /** @param {unknown} error */
    const onFailure = error => {
      if (flushed || completed) return
      log.error('Error flushing telemetry pipeline: %s', error)
      onFlushed()
    }
    try {
      const result = flusher(onFlushed)
      if (!flushed && typeof result === 'function') {
        cancellationIndex = cancellations.length
        cancellations.push(result)
      } else if (typeof result?.then === 'function') {
        result.then(onFlushed, onFailure)
      }
    } catch (error) {
      if (flushed) log.error('Error flushing telemetry pipeline: %s', error)
      else onFailure(error)
    }
  }

  const flushPostTrace = () => {
    for (const flusher of currentPostTraceFlushers) flush(flusher)
  }

  if (tracesPending === 0) {
    flushPostTrace()
  } else {
    for (const flusher of currentTraceFlushers) {
      flush(flusher, () => {
        if (--tracesPending === 0) flushPostTrace()
      })
    }
  }
  for (const flusher of currentFlushers) flush(flusher)
}

module.exports = { flushAll, registerFlusher, unregisterFlusher }
