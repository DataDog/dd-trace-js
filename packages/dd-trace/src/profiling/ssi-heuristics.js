'use strict'

const dc = /** @type {typeof import('diagnostics_channel')} */ (require('dc-polyfill'))
const log = require('../log')

// If the process lives for at least 30 seconds, it's considered long-lived
const DEFAULT_LONG_LIVED_THRESHOLD = 30_000

/**
 * This class embodies the SSI profiler-triggering heuristics under SSI.
 */
class SSIHeuristics {
  #active = false
  #longLivedTimer
  #onAppClosing = this.disable.bind(this)
  #onSpanCreated = this.#handleSpanCreated.bind(this)

  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  constructor (config) {
    const longLivedThreshold = config.DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD || DEFAULT_LONG_LIVED_THRESHOLD
    if (typeof longLivedThreshold !== 'number' || longLivedThreshold <= 0) {
      this.longLivedThreshold = DEFAULT_LONG_LIVED_THRESHOLD
      log.warn(
        'Invalid SSIHeuristics.longLivedThreshold value: %s. Using default value:',
        config.DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD,
        DEFAULT_LONG_LIVED_THRESHOLD
      )
    } else {
      this.longLivedThreshold = longLivedThreshold
    }

    this.hasSentProfiles = false
    this.noSpan = true
    this.shortLived = true
  }

  start () {
    if (this.#active) return
    this.#active = true

    // Used to determine short-livedness of the process. We could use the process start time as the
    // reference point, but the tracer initialization point is more relevant, as we couldn't be
    // collecting profiles earlier anyway. The difference is not particularly significant if the
    // tracer is initialized early in the process lifetime.
    this.#longLivedTimer = setTimeout(() => {
      this.#longLivedTimer = undefined
      this.shortLived = false
      this._maybeTriggered()
    }, this.longLivedThreshold)
    this.#longLivedTimer.unref?.()

    dc.subscribe('dd-trace:span:start', this.#onSpanCreated)
    dc.subscribe('datadog:telemetry:app-closing', this.#onAppClosing)
  }

  /**
   * Cancels the pending heuristic and releases all resources owned by this instance.
   */
  disable () {
    this.triggeredCallback = undefined
    if (!this.#active) return

    this.#active = false
    clearTimeout(this.#longLivedTimer)
    this.#longLivedTimer = undefined
    dc.unsubscribe('dd-trace:span:start', this.#onSpanCreated)
    dc.unsubscribe('datadog:telemetry:app-closing', this.#onAppClosing)
  }

  onTriggered (callback) {
    switch (typeof callback) {
      case 'undefined':
      case 'function':
        this.triggeredCallback = callback
        process.nextTick(() => {
          this._maybeTriggered()
        })
        break
      default:
        // injection hardening: only usage is internal, one call site with
        // a function and another with undefined, so we can throw here.
        throw new TypeError('callback must be a function or undefined')
    }
  }

  _maybeTriggered () {
    if (!this.shortLived && !this.noSpan && typeof this.triggeredCallback === 'function') {
      this.triggeredCallback.call(null)
    }
  }

  #handleSpanCreated () {
    this.noSpan = false
    this._maybeTriggered()
    dc.unsubscribe('dd-trace:span:start', this.#onSpanCreated)
  }
}

module.exports = { SSIHeuristics }
