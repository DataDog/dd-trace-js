'use strict'

const telemetryMetrics = require('../telemetry/metrics')
const profilersNamespace = telemetryMetrics.manager.namespace('profilers')
const performance = require('perf_hooks').performance
const dc = require('dc-polyfill')
const { isTrue, isFalse } = require('../util')

// If the process lived for less than 30 seconds, it's considered short-lived
const DEFAULT_SHORT_LIVED_THRESHOLD = 30000

const EnablementChoice = {
  MANUALLY_ENABLED: Symbol('SSITelemetry.EnablementChoice.MANUALLY_ENABLED'),
  SSI_ENABLED: Symbol('SSITelemetry.EnablementChoice.SSI_ENABLED'),
  SSI_NOT_ENABLED: Symbol('SSITelemetry.EnablementChoice.SSI_NOT_ENABLED'),
  DISABLED: Symbol('SSITelemetry.EnablementChoice.MANUALLY_DISABLED')
}
Object.freeze(EnablementChoice)

function getEnablementChoiceFromEnv () {
  const { DD_PROFILING_ENABLED, DD_INJECTION_ENABLED } = process.env
  if (DD_INJECTION_ENABLED === undefined || isFalse(DD_PROFILING_ENABLED)) {
    return EnablementChoice.DISABLED
  } else if (DD_INJECTION_ENABLED.split(',').includes('profiling')) {
    return EnablementChoice.SSI_ENABLED
  } else if (isTrue(DD_PROFILING_ENABLED)) {
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
    case EnablementChoice.MANUALLY_DISABLED:
      // Can't emit this one as a tag
      throw new Error('Invalid enablement choice')
  }
}

/**
 * This class emits telemetry metrics about the profiler behavior under SSI. It will only emit metrics
 * when the application closes, and will emit the following metrics:
 * - `number_of_profiles`: The number of profiles that were submitted
 * - `number_of_runtime_id`: The number of runtime IDs in the app (always 1 for Node.js)
 * It will also add tags describing the state of heuristics triggers, the enablement choice, and whether
 * actual profiles were sent (as opposed to mock profiles). There is a mock profiler that is activated
 * when the profiler is not enabled, and it will emit mock profile submission events at the same cadence
 * the profiler would, providing insight into how many profiles would've been emitted if SSI enabled
 * profiling. Note that telemetry is per tracer instance, and each worker thread will have its own instance.
 */
class SSITelemetry {
  constructor ({
    enablementChoice = getEnablementChoiceFromEnv(),
    shortLivedThreshold = DEFAULT_SHORT_LIVED_THRESHOLD
  } = {}) {
    if (!Object.values(EnablementChoice).includes(enablementChoice)) {
      throw new Error('Invalid enablement choice')
    }
    if (typeof shortLivedThreshold !== 'number' || shortLivedThreshold <= 0) {
      throw new Error('Short-lived threshold must be a positive number')
    }
    this.enablementChoice = enablementChoice
    this.shortLivedThreshold = shortLivedThreshold

    this.hasSentProfiles = false
    this.noSpan = true
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
      this.startTime = performance.now()

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

  _onSpanCreated () {
    this.noSpan = false
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
    if (performance.now() - this.startTime < this.shortLivedThreshold) {
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

    if (!this._emittedRuntimeId && decision[0] === 'triggered') {
      // Tags won't change anymore, so we can emit the runtime ID metric now
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

module.exports = { SSITelemetry, EnablementChoice }
