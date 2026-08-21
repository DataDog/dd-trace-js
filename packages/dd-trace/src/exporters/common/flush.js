'use strict'

/**
 * Tracks a delivery when a serverless retention boundary exists.
 *
 * @param {{ track: (deliver: (done: () => void) => void, done?: () => void) => void } | undefined} tracker
 * @param {(done?: () => void) => void} deliver
 * @param {(() => void) | undefined} done
 */
function trackDelivery (tracker, deliver, done) {
  if (tracker) return tracker.track(deliver, done)
  deliver(done)
}

/**
 * Flushes a writer and tracks the delivery when a serverless retention boundary exists.
 * `flushDirect` avoids re-entering a writer's automatic flush lifecycle hook.
 *
 * @param {{ flush: (done?: () => void) => void, flushDirect?: (done?: () => void) => void }} writer
 * @param {{ track: (deliver: (done: () => void) => void, done?: () => void) => void } | undefined} tracker
 * @param {(() => void) | undefined} done
 */
function flushWriter (writer, tracker, done) {
  const flush = writer.flushDirect ?? writer.flush
  return trackDelivery(tracker, flush.bind(writer), done)
}

module.exports = { flushWriter, trackDelivery }
