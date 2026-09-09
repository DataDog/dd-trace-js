'use strict'

/**
 * @typedef {Record<string, unknown> & { deadline?: number, signal?: AbortSignal }} RequestOptions
 */

/**
 * @typedef {object} FinalFlush
 * @property {number} deadline
 * @property {(error?: Error) => void} done
 * @property {Error | undefined} error
 * @property {Set<PendingRequest>} requests
 * @property {ReturnType<typeof setTimeout> | undefined} timeoutId
 * @property {boolean} writerDone
 */

/**
 * @typedef {object} PendingRequest
 * @property {AbortController} controller
 * @property {Set<FinalFlush>} finalFlushes
 * @property {RequestOptions} options
 */

class FinalFlushRequestTracker {
  #flush
  #createTimeoutError
  /** @type {Set<PendingRequest>} */
  #pendingRequests = new Set()
  /** @type {Set<FinalFlush>} */
  #finalFlushes = new Set()
  /** @type {FinalFlush | undefined} */
  #activeFinalFlush

  /**
   * @param {(done?: (error?: Error) => void, options?: { deadline?: number }) => void} flush
   * @param {() => Error} createTimeoutError
   */
  constructor (flush, createTimeoutError) {
    this.#flush = flush
    this.#createTimeoutError = createTimeoutError
  }

  /**
   * Flushes queued payloads and waits for requests that were already in flight.
   *
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
   * @returns {void}
   */
  flush (done, options) {
    if (options?.deadline === undefined) {
      this.#flush(done, options)
      return
    }

    /** @type {FinalFlush} */
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
      const error = this.#createTimeoutError()

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
      this.#flush((error) => {
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
   * @param {(data: Buffer|string|object, options: RequestOptions,
   *   callback: (error: Error|null, result?: string|null, statusCode?: number,
   *   headers?: import('node:http').IncomingHttpHeaders) => void) => void} request
   * @param {Buffer|string|object} data
   * @param {RequestOptions} options
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

    try {
      request(data, requestOptions, (error, result, statusCode, headers) => {
        if (error) {
          for (const finalFlush of pendingRequest.finalFlushes) finalFlush.error ||= error
        }

        try {
          callback(error, result, statusCode, headers)
        } finally {
          this.#dropRequest(pendingRequest)
        }
      })
    } catch (error) {
      this.#dropRequest(pendingRequest)
      throw error
    }
  }

  /**
   * @param {PendingRequest} pendingRequest
   * @returns {void}
   */
  #dropRequest (pendingRequest) {
    this.#pendingRequests.delete(pendingRequest)
    for (const finalFlush of pendingRequest.finalFlushes) {
      finalFlush.requests.delete(pendingRequest)
      this.#finishFinalFlush(finalFlush)
    }
    pendingRequest.finalFlushes.clear()
  }

  /**
   * @param {FinalFlush} finalFlush
   * @param {PendingRequest} pendingRequest
   * @returns {void}
   */
  #attachRequest (finalFlush, pendingRequest) {
    finalFlush.requests.add(pendingRequest)
    pendingRequest.finalFlushes.add(finalFlush)
    this.#updateRequestDeadline(pendingRequest)
  }

  /**
   * @param {PendingRequest} pendingRequest
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
   * @param {FinalFlush} finalFlush
   * @returns {void}
   */
  #finishFinalFlush (finalFlush) {
    if (!this.#finalFlushes.has(finalFlush) || !finalFlush.writerDone || finalFlush.requests.size !== 0) return

    this.#finalFlushes.delete(finalFlush)
    clearTimeout(finalFlush.timeoutId)
    finalFlush.done(finalFlush.error)
  }
}

module.exports = FinalFlushRequestTracker
