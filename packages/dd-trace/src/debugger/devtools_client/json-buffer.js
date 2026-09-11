'use strict'

/**
 * Batches JSON documents into a JSON array payload, flushed when the batch reaches its size limit or after a timeout.
 *
 * The buffer is bounded in bytes: the batch being assembled plus all flushed payloads that are still in flight (handed
 * to `onFlush` but not yet released through its `done` callback) can never exceed `maxQueueBytes`. Documents that would
 * exceed the bound are rejected instead of queued, so a stalled or slow upload target cannot make the buffer grow
 * without bound.
 */
class JSONBuffer {
  #maxSize
  #maxQueueBytes
  #timeout
  #onFlush
  #timer
  #partialJson
  #partialBytes = 0
  #inFlightBytes = 0

  /**
   * @param {object} options
   * @param {number} options.size - Maximum size in bytes of a single flushed payload
   * @param {number} options.maxQueueBytes - Maximum bytes queued, including payloads still in flight
   * @param {number} options.timeout - Milliseconds to wait for more documents before flushing a partial payload
   * @param {(json: string, done: () => void) => void} options.onFlush - Receives each payload. Must call `done` once
   *   the payload is no longer held in memory, so its bytes are released from the queue bound.
   */
  constructor ({ size, maxQueueBytes, timeout, onFlush }) {
    this.#maxSize = size
    this.#maxQueueBytes = maxQueueBytes
    this.#timeout = timeout
    this.#onFlush = onFlush
  }

  /**
   * The number of bytes currently held by the buffer, including payloads still in flight.
   *
   * @returns {number}
   */
  get queuedBytes () {
    return this.#partialBytes + this.#inFlightBytes
  }

  #flush () {
    const json = `${this.#partialJson}]`
    const bytes = this.#partialBytes + 1
    this.#partialJson = undefined
    this.#partialBytes = 0
    this.#inFlightBytes += bytes

    let released = false
    this.#onFlush(json, () => {
      if (released) return
      released = true
      this.#inFlightBytes -= bytes
    })
  }

  /**
   * Add a JSON document to the batch.
   *
   * @param {string} str - The JSON document
   * @param {number} [size] - The size of the document in bytes. Calculated if not provided.
   * @returns {boolean} `false` if the document was rejected because the queue is full, `true` otherwise
   */
  write (str, size = Buffer.byteLength(str)) {
    // The document is prefixed by `[` or `,` and the payload is terminated by `]`, hence the extra 2 bytes
    if (this.#partialJson !== undefined && this.#partialBytes + size + 2 > this.#maxSize) {
      clearTimeout(this.#timer)
      this.#timer = undefined
      this.#flush()
    }

    if (this.#partialBytes + this.#inFlightBytes + size + 2 > this.#maxQueueBytes) return false

    if (this.#partialJson === undefined) {
      this.#partialJson = `[${str}`
      this.#partialBytes = size + 1
      if (this.#timer === undefined) {
        this.#timer = setTimeout(() => this.#flush(), this.#timeout)
      } else {
        this.#timer.refresh()
      }
    } else {
      this.#partialJson += `,${str}`
      this.#partialBytes += size + 1
    }

    return true
  }
}

module.exports = JSONBuffer
