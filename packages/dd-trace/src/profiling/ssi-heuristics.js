'use strict'

const dc = require('dc-polyfill')
const log = require('../log')

// If the process lives for at least 30 seconds, it's considered long-lived
const DEFAULT_LONG_LIVED_THRESHOLD = 30_000

/**
 * This class embodies the SSI profiler-triggering heuristics under SSI.
 */
class SSIHeuristics {
  constructor (config) {
    const longLivedThreshold = config.profiling.longLivedThreshold || DEFAULT_LONG_LIVED_THRESHOLD
    if (typeof longLivedThreshold !== 'number' || longLivedThreshold <= 0) {
      this.longLivedThreshold = DEFAULT_LONG_LIVED_THRESHOLD
      log.warn(
        'Invalid SSIHeuristics.longLivedThreshold value: %s. Using default value:',
        config.profiling.longLivedThreshold,
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
    // Used to determine short-livedness of the process. We could use the process start time as the
    // reference point, but the tracer initialization point is more relevant, as we couldn't be
    // collecting profiles earlier anyway. The difference is not particularly significant if the
    // tracer is initialized early in the process lifetime.
    setTimeout(() => {
      this.shortLived = false
      this._maybeTriggered()
    }, this.longLivedThreshold).unref()

    this._onSpanCreated = this._onSpanCreated.bind(this)
    dc.subscribe('dd-trace:span:start', this._onSpanCreated)

    this._onAppClosing = this._onAppClosing.bind(this)
    dc.subscribe('datadog:telemetry:app-closing', this._onAppClosing)
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

  _onSpanCreated () {
    this.noSpan = false
    this._maybeTriggered()
    dc.unsubscribe('dd-trace:span:start', this._onSpanCreated)
  }

  _onAppClosing () {
    dc.unsubscribe('datadog:telemetry:app-closing', this._onAppClosing)
    if (this.noSpan) {
      dc.unsubscribe('dd-trace:span:start', this._onSpanCreated)
    }
  }
}

module.exports = { SSIHeuristics }
