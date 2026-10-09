'use strict'

/**
 * Tracks transport deliveries active at a flush or serverless retention boundary.
 *
 * OTLP HTTP exporters always track delivery; other exporters opt in on
 * platforms with an invocation-retention boundary.
 */
class TelemetryDeliveryTracker {
  #deliveries = new Set()

  /**
   * Tracks one asynchronous transport delivery until its callback runs.
   * @param {(done: (error?: Error) => void) => void} deliver
   * @param {((error?: Error) => void)|undefined} done
   */
  track (deliver, done) {
    const delivery = { callbacks: done ? [done] : [] }
    this.#deliveries.add(delivery)

    const complete = error => {
      if (!this.#deliveries.delete(delivery)) return
      for (const callback of delivery.callbacks) callback(error)
    }

    try {
      deliver(complete)
    } catch (error) {
      complete(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /**
   * Calls back after every delivery active at this boundary has completed, with the first failure, if any.
   * @param {((error?: Error) => void)|undefined} done
   */
  waitForIdle (done) {
    if (!done) return

    let pending = this.#deliveries.size
    if (pending === 0) return done()

    let firstError
    const complete = error => {
      firstError ||= error
      if (--pending === 0) done(firstError)
    }
    for (const delivery of this.#deliveries) delivery.callbacks.push(complete)
  }
}

module.exports = TelemetryDeliveryTracker
