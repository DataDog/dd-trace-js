'use strict'

const { storage } = require('../../../../datadog-core')

const dc = require('../../../../diagnostics_channel')
const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME, SPAN_TYPE } = require('../../../../../ext/tags')
const { WEB } = require('../../../../../ext/types')
const runtimeMetrics = require('../../runtime_metrics')
const telemetryMetrics = require('../../telemetry/metrics')

const beforeCh = dc.channel('dd-trace:storage:before')
const enterCh = dc.channel('dd-trace:storage:enter')
const profilerTelemetryMetrics = telemetryMetrics.manager.namespace('profilers')

let kSampleCount

function getActiveSpan () {
  const store = storage.getStore()
  return store && store.span
}

function getStartedSpans (context) {
  return context._trace.started
}

function generateLabels ({ spanId, rootSpanId, webTags, endpoint }) {
  const labels = {}
  if (spanId) {
    labels['span id'] = spanId
  }
  if (rootSpanId) {
    labels['local root span id'] = rootSpanId
  }
  if (webTags && Object.keys(webTags).length !== 0) {
    labels['trace endpoint'] = endpointNameFromTags(webTags)
  } else if (endpoint) {
    // fallback to endpoint computed when sample was taken
    labels['trace endpoint'] = endpoint
  }

  return labels
}

function getSpanContextTags (span) {
  return span.context()._tags
}

function isWebServerSpan (tags) {
  return tags[SPAN_TYPE] === WEB
}

function endpointNameFromTags (tags) {
  return tags[RESOURCE_NAME] || [
    tags[HTTP_METHOD],
    tags[HTTP_ROUTE]
  ].filter(v => v).join(' ')
}

function updateContext (context, span, startedSpans, endpointCollectionEnabled) {
  context.spanId = span.context().toSpanId()
  const rootSpan = startedSpans[0]
  if (rootSpan) {
    context.rootSpanId = rootSpan.context().toSpanId()
    if (endpointCollectionEnabled) {
      // Find the first webspan starting from the end:
      // There might be several webspans, for example with next.js, http plugin creates a first span
      // and then next.js plugin creates a child span, and this child span haves the correct endpoint information.
      for (let i = startedSpans.length - 1; i >= 0; i--) {
        const tags = getSpanContextTags(startedSpans[i])
        if (isWebServerSpan(tags)) {
          context.webTags = tags
          // endpoint may not be determined yet, but keep it as fallback
          // if tags are not available anymore during serialization
          context.endpoint = endpointNameFromTags(tags)
          break
        }
      }
    }
  }
}

class NativeWallProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingIntervalMicros = options.samplingInterval || 1e6 / 99 // 99hz
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._endpointCollectionEnabled = !!options.endpointCollectionEnabled
    this._v8ProfilerBugWorkaroundEnabled = !!options.v8ProfilerBugWorkaroundEnabled
    this._mapper = undefined
    this._pprof = undefined

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._logger = options.logger
    this._started = false
  }

  codeHotspotsEnabled () {
    return this._codeHotspotsEnabled
  }

  start ({ mapper } = {}) {
    if (this._started) return

    if (this._codeHotspotsEnabled && !this._emittedFFMessage && this._logger) {
      this._logger.debug(
        `Wall profiler: Enable trace_show_breakdown_profiling_for_node feature flag to see code hotspots.`)
      this._emittedFFMessage = true
    }

    this._mapper = mapper
    this._pprof = require('@datadog/pprof')
    kSampleCount = this._pprof.time.constants.kSampleCount

    // pprof otherwise crashes in worker threads
    if (!process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier = () => {}
    }
    if (!process._stopProfilerIdleNotifier) {
      process._stopProfilerIdleNotifier = () => {}
    }

    this._pprof.time.start({
      intervalMicros: this._samplingIntervalMicros,
      durationMillis: this._flushIntervalMillis,
      sourceMapper: this._mapper,
      withContexts: this._codeHotspotsEnabled,
      lineNumbers: false,
      workaroundV8Bug: this._v8ProfilerBugWorkaroundEnabled
    })

    if (this._codeHotspotsEnabled) {
      this._profilerState = this._pprof.time.getState()
      this._currentContext = {}
      this._pprof.time.setContext(this._currentContext)
      this._lastSpan = undefined
      this._lastStartedSpans = undefined
      this._lastSampleCount = 0

      beforeCh.subscribe(this._enter)
      enterCh.subscribe(this._enter)
    }

    this._started = true
  }

  _enter () {
    if (!this._started) return

    const sampleCount = this._profilerState[kSampleCount]
    if (sampleCount !== this._lastSampleCount) {
      this._lastSampleCount = sampleCount
      const context = this._currentContext
      this._currentContext = {}
      this._pprof.time.setContext(this._currentContext)

      if (this._lastSpan) {
        updateContext(context, this._lastSpan, this._lastStartedSpans, this._endpointCollectionEnabled)
      }
    }

    const span = getActiveSpan()
    if (span) {
      this._lastSpan = span
      this._lastStartedSpans = getStartedSpans(span.context())
    } else {
      this._lastStartedSpans = undefined
      this._lastSpan = undefined
    }
  }

  _reportV8bug (maybeBug) {
    const tag = `v8_profiler_bug_workaround_enabled:${this._v8ProfilerBugWorkaroundEnabled}`
    const metric = `v8_cpu_profiler${maybeBug ? '_maybe' : ''}_stuck_event_loop`
    this._logger?.warn(`Wall profiler: ${maybeBug ? 'possible ' : ''}v8 profiler stuck event loop detected.`)
    // report as runtime metric (can be removed in the future when telemetry is mature)
    runtimeMetrics.increment(`runtime.node.profiler.${metric}`, tag, true)
    // report as telemetry metric
    profilerTelemetryMetrics.count(metric, [tag]).inc()
  }

  _stop (restart) {
    if (!this._started) return
    if (this._codeHotspotsEnabled) {
      // update last sample context if needed
      this._enter()
      this._lastSampleCount = 0
    }
    const profile = this._pprof.time.stop(restart, this._codeHotspotsEnabled ? generateLabels : undefined)
    if (restart) {
      const v8BugDetected = this._pprof.time.v8ProfilerStuckEventLoopDetected()
      if (v8BugDetected !== 0) {
        this._reportV8bug(v8BugDetected === 1)
      }
    }
    return profile
  }

  profile () {
    return this._stop(true)
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    if (!this._started) return

    const profile = this._stop(false)
    if (this._codeHotspotsEnabled) {
      beforeCh.unsubscribe(this._enter)
      enterCh.subscribe(this._enter)
      this._profilerState = undefined
    }

    this._started = false
    return profile
  }
}

module.exports = NativeWallProfiler
