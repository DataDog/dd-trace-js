'use strict'

const BaseWriter = require('../../../exporters/common/writer')

const FINAL_FLUSH_TIMEOUT_CODE = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'

class TestOptimizationWriter extends BaseWriter {
  #pendingRequests = new Set()
  #finalFlushes = new Set()

  constructor () {
    super(...arguments)
    this._bufferWhenUnavailable = true
  }

  /**
   * Flushes queued payloads and, for a final flush, waits for requests that were
   * already in flight. The absolute deadline prevents Test Optimization from
   * keeping the test process alive indefinitely.
   *
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
   * @returns {void}
   */
  flush (done, options) {
    if (options?.deadline === undefined) {
      super.flush(done, options)
      return
    }

    const finalFlush = {
      done: done || (() => {}),
      error: undefined,
      timeoutId: undefined,
    }
    this.#finalFlushes.add(finalFlush)

    const remaining = Math.max(0, options.deadline - Date.now())
    finalFlush.timeoutId = setTimeout(() => {
      const error = new Error('Timed out flushing Test Optimization data')
      error.code = FINAL_FLUSH_TIMEOUT_CODE
      finalFlush.error ||= error

      for (const controller of this.#pendingRequests) controller.abort(error)

      if (this.#finalFlushes.delete(finalFlush)) finalFlush.done(finalFlush.error)
    }, remaining)

    super.flush((error) => {
      finalFlush.error ||= error
      this.#finishFinalFlushes()
    }, options)
    this.#finishFinalFlushes()
  }

  /**
   * Sends a request while tracking it so a later final flush can wait for or
   * abort it.
   *
   * @param {Function} request
   * @param {Buffer|string|object} data
   * @param {object} options
   * @param {(error: Error|null, result?: string|null, statusCode?: number) => void} callback
   * @returns {void}
   */
  _sendRequest (request, data, options, callback) {
    const controller = new AbortController()
    this.#pendingRequests.add(controller)

    request(data, { ...options, signal: controller.signal }, (error, result, statusCode) => {
      if (error) {
        for (const finalFlush of this.#finalFlushes) finalFlush.error ||= error
      }

      try {
        callback(error, result, statusCode)
      } finally {
        this.#pendingRequests.delete(controller)
        this.#finishFinalFlushes()
      }
    })
  }

  /**
   * Completes final flush callbacks once every request for this writer has
   * settled.
   *
   * @returns {void}
   */
  #finishFinalFlushes () {
    if (this.#pendingRequests.size !== 0) return

    for (const finalFlush of this.#finalFlushes) {
      clearTimeout(finalFlush.timeoutId)
      finalFlush.done(finalFlush.error)
    }
    this.#finalFlushes.clear()
  }
}

module.exports = TestOptimizationWriter
