'use strict'

/**
 * Tracks transport deliveries that must outlive a serverless request.
 *
 * Clients opt in for platform retention or bounded flush waits. Exporters
 * keep their normal callback path when the tracker is absent.
 */
class TelemetryDeliveryTracker {
  #deliveries = new Set()
  #timeoutMs
  #timeout
  #idleCallbacks

  /**
   * @param {number} [timeoutMs] Deadline for reaching idle, including new deliveries. Expiry abandons pending work.
   * Without a deadline, retain the existing snapshot-at-boundary contract.
   */
  constructor (timeoutMs) {
    this.#timeoutMs = timeoutMs
  }

  /**
   * Tracks one asynchronous transport delivery until its callback runs.
   * @param {(done: () => void) => void} deliver
   * @param {(() => void)|undefined} done
   */
  track (deliver, done) {
    const delivery = { callbacks: done ? [done] : [] }
    this.#deliveries.add(delivery)

    const complete = () => {
      if (!this.#deliveries.delete(delivery)) return
      for (const callback of delivery.callbacks) callback()
      if (this.#deliveries.size === 0 && this.#idleCallbacks) this.#completeIdleWait()
    }

    try {
      deliver(complete)
    } catch (error) {
      complete()
      throw error
    }
  }

  /**
   * Calls back after active deliveries complete. With a deadline, include new deliveries until idle or expiry.
   * @param {(() => void)|undefined} done
   */
  waitForIdle (done) {
    if (!done) return

    let pending = this.#deliveries.size
    if (pending === 0) return done()

    if (this.#timeoutMs !== undefined) {
      if (this.#idleCallbacks) {
        this.#idleCallbacks.push(done)
      } else {
        this.#idleCallbacks = [done]
        this.#timeout = setTimeout(() => {
          // Late transport callbacks must not settle a later flush after the client is reused.
          this.#deliveries.clear()
          this.#completeIdleWait()
        }, this.#timeoutMs)
      }
      return
    }

    const complete = () => {
      if (--pending === 0) done()
    }
    for (const delivery of this.#deliveries) delivery.callbacks.push(complete)
  }

  #completeIdleWait () {
    clearTimeout(this.#timeout)
    this.#timeout = undefined
    const callbacks = this.#idleCallbacks
    this.#idleCallbacks = undefined
    for (const callback of callbacks) callback()
  }
}

module.exports = TelemetryDeliveryTracker
