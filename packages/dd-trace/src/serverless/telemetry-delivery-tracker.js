'use strict'

/**
 * Tracks transport deliveries that must outlive a serverless request.
 *
 * The tracker is created only for platforms with an invocation-retention
 * boundary. Exporters keep their normal callback path when it is absent.
 */
class TelemetryDeliveryTracker {
  #deliveries = new Set()

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
    }

    try {
      deliver(complete)
    } catch (error) {
      complete()
      throw error
    }
  }

  /**
   * Calls back after every delivery active at this boundary has completed.
   * @param {(() => void)|undefined} done
   */
  waitForIdle (done) {
    if (!done) return

    let pending = this.#deliveries.size
    if (pending === 0) return done()

    const complete = () => {
      if (--pending === 0) done()
    }
    for (const delivery of this.#deliveries) delivery.callbacks.push(complete)
  }
}

module.exports = TelemetryDeliveryTracker
