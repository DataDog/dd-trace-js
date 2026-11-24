'use strict'

const log = require('../../log')

const request = require('../common/request')

const REQUEST_TIMEOUT_MS = 15_000
const FIRST_RETRY_DELAY_MS = 1000
const MAX_RETRIES = 2
const MAX_PENDING_BATCHES = 64
const MAX_PENDING_BYTES = 16 * 1024 * 1024

let pendingBatches = 0
let pendingBytes = 0

class DirectTransport {
  #pending = new Set()

  /**
   * @param {Uint8Array} body
   * @param {Parameters<typeof request>[1]} options
   * @param {(failure: Error | number | null) => void} done
   */
  send (body, options, done) {
    const bytes = body.byteLength
    if (pendingBatches >= MAX_PENDING_BATCHES || pendingBytes + bytes > MAX_PENDING_BYTES) {
      try {
        done(null)
      } catch (error) {
        log.error('Failed to complete a discarded agentless batch: %s', error)
      }
      return
    }

    const pending = this.#pending
    let controller
    let deadline
    let backoff
    let retries = 0

    /**
     * @param {Error | number | null} failure
     * @param {boolean} [aborted]
     */
    function finish (failure, aborted = false) {
      if (!pending.delete(cancel)) {
        return
      }
      pendingBatches--
      pendingBytes -= bytes
      clearTimeout(deadline)
      clearTimeout(backoff)
      if (aborted) {
        controller?.abort()
        queueMicrotask(() => done(null))
      } else {
        done(failure)
      }
    }

    function cancel () {
      finish(null, true)
    }

    /** @type {Parameters<typeof request>[2]} */
    const onResponse = (error, _result, status, _headers, dropped) => {
      if (!pending.has(cancel)) {
        return
      }
      clearTimeout(deadline)
      controller = undefined
      if ((status !== undefined && status < 400) || dropped) {
        finish(null)
      } else if (error && retries < MAX_RETRIES) {
        const delay = FIRST_RETRY_DELAY_MS * 2 ** retries
        retries++
        backoff = setTimeout(attempt, delay)
        backoff.unref?.()
      } else {
        finish(status ?? error)
      }
    }

    function attempt () {
      const current = new AbortController()
      controller = current
      deadline = setTimeout(() => current.abort(), REQUEST_TIMEOUT_MS)
      deadline.unref?.()
      try {
        request(body, {
          ...options,
          agent: false,
          retry: false,
          signal: current.signal,
          timeout: REQUEST_TIMEOUT_MS,
        }, onResponse)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    pending.add(cancel)
    pendingBatches++
    pendingBytes += bytes
    attempt()
  }

  close () {
    for (const cancel of this.#pending) {
      cancel()
    }
  }
}

module.exports = DirectTransport
