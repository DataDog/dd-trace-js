'use strict'

const BaseWriter = require('../../../exporters/common/writer')

const FINAL_FLUSH_TIMEOUT_CODE = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'

class TestOptimizationRequestTracker {
  #writer
  #pendingRequests = new Set()
  #finalFlushes = new Set()
  #activeFinalFlush

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
      BaseWriter.prototype.flushDirect.call(this.#writer, done, options)
      return
    }

    const finalFlush = {
      deadline: options.deadline,
      done: done || (() => {}),
      error: undefined,
      requests: new Set(),
      timeoutId: undefined,
      writerDone: false,
    }
    this.#finalFlushes.add(finalFlush)

    for (const pendingRequest of this.#pendingRequests) {
      this.#attachRequest(finalFlush, pendingRequest)
    }

    const remaining = Math.max(0, options.deadline - Date.now())
    finalFlush.timeoutId = setTimeout(() => {
      const error = new Error('Timed out flushing Test Optimization data')
      error.code = FINAL_FLUSH_TIMEOUT_CODE

      finalFlush.error ||= error
      finalFlush.writerDone = true

      for (const pendingRequest of finalFlush.requests) {
        pendingRequest.finalFlushes.delete(finalFlush)
        if (pendingRequest.finalFlushes.size === 0) {
          pendingRequest.controller.abort(error)
          this.#pendingRequests.delete(pendingRequest)
        } else {
          this.#updateRequestDeadline(pendingRequest)
        }
      }
      finalFlush.requests.clear()
      this.#finishFinalFlush(finalFlush)
    }, remaining)

    const previousFinalFlush = this.#activeFinalFlush
    this.#activeFinalFlush = finalFlush
    try {
      BaseWriter.prototype.flushDirect.call(this.#writer, (error) => {
        finalFlush.error ||= error
        finalFlush.writerDone = true
        this.#finishFinalFlush(finalFlush)
      }, options)
    } finally {
      this.#activeFinalFlush = previousFinalFlush
    }
    this.#finishFinalFlush(finalFlush)
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
    const pendingRequest = { controller, finalFlushes: new Set(), options: requestOptions }
    this.#pendingRequests.add(pendingRequest)
    if (this.#activeFinalFlush) this.#attachRequest(this.#activeFinalFlush, pendingRequest)

    request(data, requestOptions, (error, result, statusCode, headers) => {
      if (error) {
        for (const finalFlush of pendingRequest.finalFlushes) finalFlush.error ||= error
      }

      try {
        callback(error, result, statusCode, headers)
      } finally {
        this.#pendingRequests.delete(pendingRequest)
        for (const finalFlush of pendingRequest.finalFlushes) {
          finalFlush.requests.delete(pendingRequest)
          this.#finishFinalFlush(finalFlush)
        }
        pendingRequest.finalFlushes.clear()
      }
    })
  }

  /**
   * Associates a request with the final flush boundary that must wait for it.
   *
   * @param {object} finalFlush
   * @param {object} pendingRequest
   * @returns {void}
   */
  #attachRequest (finalFlush, pendingRequest) {
    finalFlush.requests.add(pendingRequest)
    pendingRequest.finalFlushes.add(finalFlush)
    this.#updateRequestDeadline(pendingRequest)
  }

  /**
   * Gives a shared request the latest deadline of the flushes waiting for it.
   *
   * @param {object} pendingRequest
   * @returns {void}
   */
  #updateRequestDeadline (pendingRequest) {
    let deadline = 0
    for (const finalFlush of pendingRequest.finalFlushes) {
      deadline = Math.max(deadline, finalFlush.deadline)
    }
    pendingRequest.options.deadline = deadline
  }

  /**
   * Completes a final flush callback once its writer and associated requests
   * have settled.
   *
   * @param {object} finalFlush
   * @returns {void}
   */
  #finishFinalFlush (finalFlush) {
    if (!this.#finalFlushes.has(finalFlush) || !finalFlush.writerDone || finalFlush.requests.size !== 0) return

    this.#finalFlushes.delete(finalFlush)
    clearTimeout(finalFlush.timeoutId)
    finalFlush.done(finalFlush.error)
  }
}

module.exports = TestOptimizationRequestTracker
