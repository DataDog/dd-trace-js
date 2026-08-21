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

    let completed = false
    const complete = () => {
      if (completed) return
      completed = true
      this.#deliveries.delete(delivery)
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

    const deliveries = [...this.#deliveries]
    if (deliveries.length === 0) return done()

    let pending = deliveries.length
    const complete = () => {
      if (--pending === 0) done()
    }
    for (const delivery of deliveries) delivery.callbacks.push(complete)
  }
}

module.exports = TelemetryDeliveryTracker
