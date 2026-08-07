'use strict'

const BaseWriter = require('../../../exporters/common/writer')

const FINAL_FLUSH_TIMEOUT_CODE = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'

class TestOptimizationRequestTracker {
  #writer
  #pendingRequests = new Set()
  #finalFlushes = new Set()

  /**
   * Creates request tracking for a Test Optimization writer.
   *
   * @param {BaseWriter} writer
   */
  constructor (writer) {
    this.#writer = writer
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
      BaseWriter.prototype.flush.call(this.#writer, done, options)
      return
    }

    for (const pendingRequest of this.#pendingRequests) {
      pendingRequest.options.deadline = options.deadline
      pendingRequest.options.retryOnHttpError = true
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

      for (const pendingFinalFlush of this.#finalFlushes) pendingFinalFlush.error ||= error
      for (const pendingRequest of this.#pendingRequests) pendingRequest.controller.abort(error)
      this.#pendingRequests.clear()
      this.#finishFinalFlushes()
    }, remaining)

    BaseWriter.prototype.flush.call(this.#writer, (error) => {
      finalFlush.error ||= error
      this.#finishFinalFlushes()
    }, options)
    this.#finishFinalFlushes()
  }

  /**
   * Sends and tracks a request so a later final flush can wait for or abort it.
   *
   * @param {Function} request
   * @param {Buffer|string|object} data
   * @param {object} options
   * @param {(error: Error|null, result?: string|null, statusCode?: number,
   *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
   * @returns {void}
   */
  send (request, data, options, callback) {
    const controller = new AbortController()
    const requestOptions = { ...options, signal: controller.signal }
    const pendingRequest = { controller, options: requestOptions }
    this.#pendingRequests.add(pendingRequest)

    request(data, requestOptions, (error, result, statusCode, headers) => {
      if (error) {
        for (const finalFlush of this.#finalFlushes) finalFlush.error ||= error
      }

      try {
        callback(error, result, statusCode, headers)
      } finally {
        this.#pendingRequests.delete(pendingRequest)
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
      this.#finalFlushes.delete(finalFlush)
      clearTimeout(finalFlush.timeoutId)
      finalFlush.done(finalFlush.error)
    }
  }
}

module.exports = TestOptimizationRequestTracker
