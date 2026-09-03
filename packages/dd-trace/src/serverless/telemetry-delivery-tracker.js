'use strict'

const getFlushError = require('../flush-error')

/**
 * Tracks transport deliveries until a completion boundary.
 *
 * Serverless exporters use the boundary to retain an invocation. OTLP
 * exporters use it to make explicit flushes wait for active HTTP requests.
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

    const complete = (error) => {
      if (!this.#deliveries.delete(delivery)) return
      for (const callback of delivery.callbacks) callback(error)
    }

    try {
      deliver(complete)
    } catch (error) {
      complete(error)
      throw error
    }
  }

  /**
   * Calls back after every delivery active at this boundary has completed.
   * @param {((error?: Error) => void)|undefined} done
   * @param {{ reportErrors?: boolean }} [options]
   */
  waitForIdle (done, options) {
    if (!done) return

    const errors = []
    let pending = this.#deliveries.size
    const finish = () => {
      done(options?.reportErrors ? getFlushError(errors) : undefined)
    }
    if (pending === 0) return finish()

    const complete = (error) => {
      if (error) errors.push(error)
      if (--pending === 0) finish()
    }
    for (const delivery of this.#deliveries) delivery.callbacks.push(complete)
  }
}

module.exports = TelemetryDeliveryTracker
