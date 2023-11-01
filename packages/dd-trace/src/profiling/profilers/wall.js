'use strict'

const { storage } = require('../../../../datadog-core')

const dc = require('../../../../diagnostics_channel')
const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME, SPAN_TYPE } = require('../../../../../ext/tags')
const { WEB } = require('../../../../../ext/types')
const runtimeMetrics = require('../../runtime_metrics')
const telemetryMetrics = require('../../telemetry/metrics')

const beforeCh = dc.channel('dd-trace:storage:before')
const enterCh = dc.channel('dd-trace:storage:enter')
const spanFinishCh = dc.channel('dd-trace:span:finish')
const profilerTelemetryMetrics = telemetryMetrics.manager.namespace('profilers')
const SampleContextsSymbol = Symbol('NativeWallProfiler.SampleContexts')
const WebContextSymbol = Symbol('NativeWallProfiler.WebContext')

const threadName = (function () {
  const { isMainThread, threadId } = require('node:worker_threads')
  const name = isMainThread ? 'Main' : `Worker #${threadId}`
  return `${name} Event Loop`
})()

let kSampleCount

function getActiveSpan () {
  const store = storage.getStore()
  return store && store.span
}

function generateLabels ({ context: { spanId, rootSpanId, webTags, endpoint }, timestamp }) {
  const labels = { 'thread name': threadName }
  if (spanId) {
    labels['span id'] = spanId
  }
  if (rootSpanId) {
    labels['local root span id'] = rootSpanId
  }
  if (endpoint) {
    // Already computed by _spanFinished()
    labels['trace endpoint'] = endpoint
  } else if (webTags && Object.keys(webTags).length !== 0) {
    // The span has not finished yet, or finished before we could register this context with it in
    // _updateContext, so let's try to compute the endpoint name from tags. This is last-ditch
    // best-effort; it's entirely possible we won't be able to compute it as the tags aren't present
    // yet, but we are serializing the profile already, so we can't defer it any longer.
    const currEndpoint = endpointNameFromTags(webTags)
    if (currEndpoint) {
      labels['trace endpoint'] = currEndpoint
    }
    // Release the tags object. This also marks to _spanFinished() that we don't need endpoint to be
    // set anymore.
    context.webTags = undefined
  }
  // Incoming timestamps are in microseconds, we emit nanos.
  labels['end_timestamp_ns'] = timestamp * 1000n

  return labels
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

class NativeWallProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingIntervalMicros = options.samplingInterval || 1e6 / 99 // 99hz
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._endpointCollectionEnabled = !!options.endpointCollectionEnabled
    this._withContexts = this._codeHotspotsEnabled || this._endpointCollectionEnabled
    this._v8ProfilerBugWorkaroundEnabled = !!options.v8ProfilerBugWorkaroundEnabled
    this._mapper = undefined
    this._pprof = undefined

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._spanFinished = this._spanFinished.bind(this)

    this._logger = options.logger
    this._started = false
  }

  codeHotspotsEnabled () {
    return this._codeHotspotsEnabled
  }

  endpointCollectionEnabled () {
    return this._endpointCollectionEnabled
  }

  start ({ mapper } = {}) {
    if (this._started) return

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
      withContexts: this._withContexts,
      lineNumbers: false,
      workaroundV8Bug: this._v8ProfilerBugWorkaroundEnabled
    })

    if (this._withContexts) {
      this._profilerState = this._pprof.time.getState()
      this._currentContext = {}
      this._pprof.time.setContext(this._currentContext)
      this._lastSampleCount = 0
      this._clearLast()

      beforeCh.subscribe(this._enter)
      enterCh.subscribe(this._enter)
      spanFinishCh.subscribe(this._spanFinished)
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

      this._updateContext(context)
    }

    // We defer as much processing as possible until _updateContext, so here we only grab references
    // to objects we might need in _updateContext.
    const span = getActiveSpan()
    if (span) {
      const spanContext = span.context()
      const trace = spanContext._trace
      const startedSpans = trace.started
      if (this._codeHotspotsEnabled && trace.record) {
        this._lastSpan = span
        this._lastRootSpan = startedSpans[0]
      } else {
        this._lastSpan = undefined
        this._lastRootSpan = undefined
      }
      if (this._endpointCollectionEnabled) {
        // We need to grab the context and the tags of the started span with web information. We
        // need to do it here instead of in _updateContext in case the span finishes between here
        // and the _updateContext call and span_processor.js replaces the context's tag container
        // with an empty object.

        // Cache lookup of web context for this span context. It's either itself or one of its
        // parent spans' contexts.
        const webContext = spanContext[WebContextSymbol]
        if (webContext === undefined) {
          // Not cached yet. Find the first webspan starting from the innermost span. There might be
          // several webspans, for example with next.js, http plugin creates a first span and then
          // next.js plugin creates a child span, and this child span has the correct endpoint
          // information.
          let found = false
          for (let i = startedSpans.length - 1; i >= 0; i--) {
            const sspan = startedSpans[i]
            if (sspan._duration !== undefined) {
              // span is listed in trace started, but it finished in the meantime
              continue
            }
            const scontext = startedSpans[i].context()
            const tags = scontext._tags
            if (isWebServerSpan(tags)) {
              this._lastWebContext = scontext
              this._lastWebTags = tags
              // Cache so next time this span activates we don't need to lookup again
              spanContext[WebContextSymbol] = scontext
              found = true
              break
            }
          }
          if (!found) {
            this._lastWebContext = undefined
            this._lastWebTags = undefined
            // Cache negative lookup so next time this span activates we don't need to lookup again
            spanContext[WebContextSymbol] = null
          }
        } else if (webContext === null) {
          // Use negative cache lookup info
          this._lastWebTags = undefined
          this._lastWebContext = undefined
        } else {
          // Use cached lookup info
          this._lastWebContext = webContext
          this._lastWebTags = webContext._tags
        }
      }
    } else {
      this._clearLast()
    }
  }

  _clearLast () {
    this._lastSpan = undefined
    this._lastRootSpan = undefined
    this._lastWebTags = undefined
    this._lastWebContext = undefined
  }

  _updateContext (context) {
    if (this._lastSpan) {
      context.spanId = this._lastSpan.context().toSpanId()
    }
    if (this._lastRootSpan) {
      context.rootSpanId = this._lastRootSpan.context().toSpanId()
    }
    if (this._lastWebTags) {
      // Store a reference to the tags object; we'll use it to try to compute the endpoint name if
      // we serialize the profile before the span ended in generateLabels.
      context.webTags = this._lastWebTags
    }
    if (this._lastWebContext && !this._lastWebContext._isFinished) {
      // Store a reference to this sample context in the webspan's context. We'll use those to
      // compute the endpoint name if the span ended before we serialized the profile in
      // _spanFinished()
      const sampleContexts = this._lastWebContext[SampleContextsSymbol]
      if (!sampleContexts) {
        this._lastWebContext[SampleContextsSymbol] = [context]
      } else {
        sampleContexts.push(context)
      }
    }
  }

  _spanFinished (span) {
    if (!this._started) return

    const spanContext = span.context()
    if (spanContext.hasOwnProperty(WebContextSymbol)) {
      spanContext[WebContextSymbol] = undefined
    }
    const sampleContexts = spanContext[SampleContextsSymbol]
    if (sampleContexts) {
      const endpoint = endpointNameFromTags(spanContext._tags)
      for (const sampleContext of sampleContexts) {
        // if sampleContext.webTags is undefined, we already serialized the profile.
        if (sampleContext.webTags) {
          sampleContext.endpoint = endpoint
          // generateLables() shouldn't compute the endpoint
          sampleContext.webTags = undefined
        }
      }
      spanContext[SampleContextsSymbol] = undefined
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
    if (this._withContexts) {
      // update last sample context if needed
      this._enter()
      this._lastSampleCount = 0
    }
    const profile = this._pprof.time.stop(restart, this._withContexts ? generateLabels : undefined)
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
    if (this._withContexts) {
      beforeCh.unsubscribe(this._enter)
      enterCh.unsubscribe(this._enter)
      spanFinishCh.unsubscribe(this._spanFinished)
      this._profilerState = undefined
    }

    this._started = false
    return profile
  }
}

module.exports = NativeWallProfiler
