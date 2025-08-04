'use strict'

class PoissonProcessSamplingFilter {
  #currentSamplingInstant = 0
  #nextSamplingInstant
  #samplingInterval
  #resetInterval
  #now
  #lastNow = Number.NEGATIVE_INFINITY
  #samplingInstantCount = 0

  constructor ({ samplingInterval, now, resetInterval }) {
    if (samplingInterval <= 0) {
      throw new RangeError(`samplingInterval (${samplingInterval}) must be greater than 0`)
    }
    if (resetInterval < samplingInterval) {
      throw new RangeError(
        `resetInterval (${resetInterval}) must be greater than samplingInterval (${samplingInterval})`
      )
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function')
    }
    this.#samplingInterval = samplingInterval
    this.#resetInterval = resetInterval
    this.#now = now
    this.#nextSamplingInstant = this.#callNow()
    this.#setNextSamplingInstant()
  }

  get currentSamplingInstant () {
    return this.#currentSamplingInstant
  }

  get nextSamplingInstant () {
    return this.#nextSamplingInstant
  }

  get samplingInstantCount () {
    return this.#samplingInstantCount
  }

  #callNow () {
    const nowValue = this.#now()
    if (typeof nowValue !== 'number') {
      throw new TypeError('now() must return a number')
    }
    if (nowValue < this.#lastNow) {
      throw new RangeError('now() must return a value greater than or equal to the last returned value')
    }
    this.#lastNow = nowValue
    return nowValue
  }

  filter (event) {
    const endTime = event.startTime + event.duration
    // We're using the end times of events as an approximation of current time as events are
    // expected to be reported close to where they ended. If the end time (and thus, presumably, the
    // current time) is past the next sampling instant, we make it the current sampling instant and
    // compute the next sampling instant in its future.
    if (endTime >= this.#nextSamplingInstant) {
      // All observed events are supposed to have happened in the past. For purposes of advancing
      // the next sampling instant, we cap endTime to now(). This protects us from advancing it far
      // into future if we receive an event with erroneously long duration, which would also take
      // many iterations of the below "while" loop.
      const cappedEndTime = Math.min(endTime, this.#callNow())

      // If nextSamplingInstant is far in cappedEndTime's past, first advance it close to it. This
      // can happen if we didn't receive any events for a while. Since a Poisson process has no
      // memory, we can reset it anytime. This will ensure that the "while" loop below runs at most
      // few iterations.
      const earliestContinuousPast = cappedEndTime - this.#resetInterval
      if (this.#nextSamplingInstant < earliestContinuousPast) {
        this.#nextSamplingInstant = earliestContinuousPast
      }

      // Advance the next sampling instant until it is in cappedEndTime's future.
      while (cappedEndTime >= this.#nextSamplingInstant) {
        this.#setNextSamplingInstant()
      }
    }
    // An event is sampled if it started before, and ended on or after a sampling instant. The above
    // while loop will ensure that the ending invariant is always true for the current sampling
    // instant so we don't have to test for it below. Across calls, the invariant also holds as long
    // as the events arrive in endTime order. This is true for events coming from
    // DatadogInstrumentationEventSource; they will be ordered by endTime by virtue of this method
    // being invoked synchronously with the plugins' finish() handler which evaluates
    // performance.now(). OTOH, events coming from NodeAPIEventSource (GC in typical setup) might be
    // somewhat delayed as they are queued by Node, so they can arrive out of order with regard to
    // events coming from the non-queued source. By omitting the endTime check, we will pass through
    // some short events that started and ended before the current sampling instant. OTOH, if we
    // were to check for this.currentSamplingInstant <= endTime, we would discard some long events
    // that also ended before the current sampling instant. We'd rather err on the side of including
    // some short events than excluding some long events.
    return event.startTime < this.#currentSamplingInstant
  }

  #setNextSamplingInstant () {
    this.#currentSamplingInstant = this.#nextSamplingInstant
    this.#nextSamplingInstant -= Math.log(1 - Math.random()) * this.#samplingInterval
    this.#samplingInstantCount++
  }
}

module.exports = PoissonProcessSamplingFilter
