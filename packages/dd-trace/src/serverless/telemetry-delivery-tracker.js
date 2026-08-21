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

/**
 * Starts a delivery through the serverless tracker when one is active.
 * Outside supported serverless platforms, delivery keeps the existing callback path.
 *
 * @param {TelemetryDeliveryTracker | undefined} tracker
 * @param {(done?: () => void) => void} deliver
 * @param {(() => void) | undefined} done
 */
function trackDelivery (tracker, deliver, done) {
  if (tracker) return tracker.track(deliver, done)
  deliver(done)
}

/**
 * Flushes a writer through the serverless delivery tracker.
 * `flushDirect` avoids re-entering an automatic writer flush lifecycle hook.
 *
 * @param {{ flush: (done?: () => void) => void, flushDirect?: (done?: () => void) => void }} writer
 * @param {TelemetryDeliveryTracker | undefined} tracker
 * @param {(() => void) | undefined} done
 */
function flushWriter (writer, tracker, done) {
  const flush = writer.flushDirect ?? writer.flush
  return trackDelivery(tracker, flush.bind(writer), done)
}

module.exports = TelemetryDeliveryTracker
module.exports.flushWriter = flushWriter
module.exports.trackDelivery = trackDelivery
