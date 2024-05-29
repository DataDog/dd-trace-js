'use strict'

const telemetryMetrics = require('../telemetry/metrics')
const profilersNamespace = telemetryMetrics.manager.namespace('profilers')
const dc = require('dc-polyfill')

// If the process lives for at least 30 seconds, it's considered long-lived
const DEFAULT_LONG_LIVED_THRESHOLD = 30000

const EnablementChoice = {
  MANUALLY_ENABLED: Symbol('SSITelemetry.EnablementChoice.MANUALLY_ENABLED'),
  SSI_ENABLED: Symbol('SSITelemetry.EnablementChoice.SSI_ENABLED'),
  SSI_NOT_ENABLED: Symbol('SSITelemetry.EnablementChoice.SSI_NOT_ENABLED'),
  DISABLED: Symbol('SSITelemetry.EnablementChoice.DISABLED')
}
Object.freeze(EnablementChoice)

function getEnablementChoiceFromConfig (config) {
  if (config.ssi === false || config.enabled === false) {
    return EnablementChoice.DISABLED
  } else if (config.heuristicsEnabled === true) {
    return EnablementChoice.SSI_ENABLED
  } else if (config.enabled === true) {
    return EnablementChoice.MANUALLY_ENABLED
  } else {
    return EnablementChoice.SSI_NOT_ENABLED
  }
}

function enablementChoiceToTagValue (enablementChoice) {
  switch (enablementChoice) {
    case EnablementChoice.MANUALLY_ENABLED:
      return 'manually_enabled'
    case EnablementChoice.SSI_ENABLED:
      return 'ssi_enabled'
    case EnablementChoice.SSI_NOT_ENABLED:
      return 'not_enabled'
    case EnablementChoice.DISABLED:
      // Can't emit this one as a tag
      throw new Error('Invalid enablement choice')
  }
}

/**
 * This class embodies the SSI profiler-triggering heuristics and also emits telemetry metrics about
 * the profiler behavior under SSI. It emits the following metrics:
 * - `number_of_profiles`: The number of profiles that were submitted
 * - `number_of_runtime_id`: The number of runtime IDs in the app (always 1 for Node.js, emitted
 *   once when the tags won't change for the remaineder of of the app's lifetime.)
 * It will also add tags describing the state of heuristics triggers, the enablement choice, and
 * whether actual profiles were sent (as opposed to mock profiles). There is a mock profiler that is
 * activated when the profiler is not enabled, and it will emit mock profile submission events at
 * the same cadence the profiler would, providing insight into how many profiles would've been
 * emitted if SSI enabled profiling. Note that heuristics (and thus telemetry) is per tracer
 * instance, and each worker thread will have its own instance.
 */
class SSIHeuristics {
  constructor (config) {
    this.enablementChoice = getEnablementChoiceFromConfig(config)

    const longLivedThreshold = config.longLivedThreshold || DEFAULT_LONG_LIVED_THRESHOLD
    if (typeof longLivedThreshold !== 'number' || longLivedThreshold <= 0) {
      throw new Error('Long-lived threshold must be a positive number')
    }
    this.longLivedThreshold = longLivedThreshold

    this.hasSentProfiles = false
    this.noSpan = true
    this.shortLived = true
  }

  enabled () {
    return this.enablementChoice !== EnablementChoice.DISABLED
  }

  start () {
    if (this.enabled()) {
      // Used to determine short-livedness of the process. We could use the process start time as the
      // reference point, but the tracer initialization point is more relevant, as we couldn't be
      // collecting profiles earlier anyway. The difference is not particularly significant if the
      // tracer is initialized early in the process lifetime.
      setTimeout(() => {
        this.shortLived = false
        this._maybeTriggered()
      }, this.longLivedThreshold).unref()

      this._onSpanCreated = this._onSpanCreated.bind(this)
      this._onProfileSubmitted = this._onProfileSubmitted.bind(this)
      this._onMockProfileSubmitted = this._onMockProfileSubmitted.bind(this)
      this._onAppClosing = this._onAppClosing.bind(this)

      dc.subscribe('dd-trace:span:start', this._onSpanCreated)
      dc.subscribe('datadog:profiling:profile-submitted', this._onProfileSubmitted)
      dc.subscribe('datadog:profiling:mock-profile-submitted', this._onMockProfileSubmitted)
      dc.subscribe('datadog:telemetry:app-closing', this._onAppClosing)
    }
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
        throw new TypeError('callback must be a function or undefined')
    }
  }

  _maybeTriggered () {
    if (!this.shortLived && !this.noSpan) {
      if (typeof this.triggeredCallback === 'function') {
        this.triggeredCallback.call(null)
      }
    }
  }

  _onSpanCreated () {
    this.noSpan = false
    this._maybeTriggered()
    dc.unsubscribe('dd-trace:span:start', this._onSpanCreated)
  }

  _onProfileSubmitted () {
    this.hasSentProfiles = true
    this._incProfileCount()
  }

  _onMockProfileSubmitted () {
    this._incProfileCount()
  }

  _incProfileCount () {
    this._ensureProfileMetrics()
    this._profileCount.inc()
  }

  _ensureProfileMetrics () {
    const decision = []
    if (this.noSpan) {
      decision.push('no_span')
    }
    if (this.shortLived) {
      decision.push('short_lived')
    }
    if (decision.length === 0) {
      decision.push('triggered')
    }

    const tags = [
      'installation:ssi',
      `enablement_choice:${enablementChoiceToTagValue(this.enablementChoice)}`,
      `has_sent_profiles:${this.hasSentProfiles}`,
      `heuristic_hypothetical_decision:${decision.join('_')}`
    ]

    this._profileCount = profilersNamespace.count('ssi_heuristic.number_of_profiles', tags)
    this._runtimeIdCount = profilersNamespace.count('ssi_heuristic.number_of_runtime_id', tags)

    if (
      !this._emittedRuntimeId &&
      decision[0] === 'triggered' &&
      // When enablement choice is SSI_ENABLED, hasSentProfiles can transition from false to true when the
      // profiler gets started and the first profile is submitted, so we have to wait for it.
      (this.enablementChoice !== EnablementChoice.SSI_ENABLED || this.hasSentProfiles)
    ) {
      // Tags won't change anymore, so we can emit the runtime ID metric now.
      this._emittedRuntimeId = true
      this._runtimeIdCount.inc()
    }
  }

  _onAppClosing () {
    this._ensureProfileMetrics()
    // Last ditch effort to emit a runtime ID count metric
    if (!this._emittedRuntimeId) {
      this._emittedRuntimeId = true
      this._runtimeIdCount.inc()
    }
    // So we have the metrics in the final state
    this._profileCount.inc(0)

    dc.unsubscribe('datadog:profiling:profile-submitted', this._onProfileSubmitted)
    dc.unsubscribe('datadog:profiling:mock-profile-submitted', this._onMockProfileSubmitted)
    dc.unsubscribe('datadog:telemetry:app-closing', this._onAppClosing)
    if (this.noSpan) {
      dc.unsubscribe('dd-trace:span:start', this._onSpanCreated)
    }
  }
}

module.exports = { SSIHeuristics, EnablementChoice }
