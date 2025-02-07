'use strict'

const { storage } = require('../../../../datadog-core')

const dc = require('dc-polyfill')
const runtimeMetrics = require('../../runtime_metrics')
const telemetryMetrics = require('../../telemetry/metrics')
const {
  END_TIMESTAMP_LABEL,
  SPAN_ID_LABEL,
  LOCAL_ROOT_SPAN_ID_LABEL,
  getNonJSThreadsLabels,
  getThreadLabels
} = require('./shared')

const { isWebServerSpan, endpointNameFromTags, getStartedSpans } = require('../webspan-utils')

const beforeCh = dc.channel('dd-trace:storage:before')
const enterCh = dc.channel('dd-trace:storage:enter')
const spanFinishCh = dc.channel('dd-trace:span:finish')
const profilerTelemetryMetrics = telemetryMetrics.manager.namespace('profilers')

const ProfilingContext = Symbol('NativeWallProfiler.ProfilingContext')

let kSampleCount

function getActiveSpan () {
  const store = storage('legacy').getStore()
  return store && store.span
}

let channelsActivated = false
function ensureChannelsActivated () {
  if (channelsActivated) return

  const { AsyncLocalStorage, createHook } = require('async_hooks')
  const shimmer = require('../../../../datadog-shimmer')

  createHook({ before: () => beforeCh.publish() }).enable()

  let inRun = false
  shimmer.wrap(AsyncLocalStorage.prototype, 'enterWith', function (original) {
    return function (...args) {
      const retVal = original.apply(this, args)
      if (!inRun) enterCh.publish()
      return retVal
    }
  })

  shimmer.wrap(AsyncLocalStorage.prototype, 'run', function (original) {
    return function (store, callback, ...args) {
      const wrappedCb = shimmer.wrapFunction(callback, cb => function (...args) {
        inRun = false
        enterCh.publish()
        const retVal = cb.apply(this, args)
        inRun = true
        return retVal
      })
      inRun = true
      const retVal = original.call(this, store, wrappedCb, ...args)
      enterCh.publish()
      inRun = false
      return retVal
    }
  })

  channelsActivated = true
}

class NativeWallProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingIntervalMicros = options.samplingInterval || 1e6 / 99 // 99hz
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._endpointCollectionEnabled = !!options.endpointCollectionEnabled
    this._timelineEnabled = !!options.timelineEnabled
    this._cpuProfilingEnabled = !!options.cpuProfilingEnabled
    // We need to capture span data into the sample context for either code hotspots
    // or endpoint collection.
    this._captureSpanData = this._codeHotspotsEnabled || this._endpointCollectionEnabled
    // We need to run the pprof wall profiler with sample contexts if we're either
    // capturing span data or timeline is enabled (so we need sample timestamps, and for now
    // timestamps require the sample contexts feature in the pprof wall profiler), or
    // cpu profiling is enabled.
    this._withContexts = this._captureSpanData || this._timelineEnabled || this._cpuProfilingEnabled
    this._v8ProfilerBugWorkaroundEnabled = !!options.v8ProfilerBugWorkaroundEnabled
    this._mapper = undefined
    this._pprof = undefined

    // Bind these to this so they can be used as callbacks
    if (this._withContexts) {
      if (this._captureSpanData) {
        this._enter = this._enter.bind(this)
        this._spanFinished = this._spanFinished.bind(this)
      }
    }
    this._generateLabels = this._generateLabels.bind(this)

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

    ensureChannelsActivated()

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
      workaroundV8Bug: this._v8ProfilerBugWorkaroundEnabled,
      collectCpuTime: this._cpuProfilingEnabled
    })

    if (this._withContexts) {
      this._setNewContext()

      if (this._captureSpanData) {
        this._profilerState = this._pprof.time.getState()
        this._lastSampleCount = 0

        beforeCh.subscribe(this._enter)
        enterCh.subscribe(this._enter)
        spanFinishCh.subscribe(this._spanFinished)
      }
    }

    this._started = true
  }

  _enter () {
    if (!this._started) return

    const sampleCount = this._profilerState[kSampleCount]
    if (sampleCount !== this._lastSampleCount) {
      this._lastSampleCount = sampleCount
      const context = this._currentContext.ref
      this._setNewContext()

      this._updateContext(context)
    }

    const span = getActiveSpan()
    this._currentContext.ref = span ? this._getProfilingContext(span) : {}
  }

  _getProfilingContext (span) {
    let profilingContext = span[ProfilingContext]
    if (profilingContext === undefined) {
      const context = span.context()
      const startedSpans = getStartedSpans(context)

      let spanId
      let rootSpanId
      if (this._codeHotspotsEnabled) {
        spanId = context._spanId
        rootSpanId = startedSpans.length ? startedSpans[0].context()._spanId : context._spanId
      }

      let webTags
      if (this._endpointCollectionEnabled) {
        const tags = context._tags
        if (isWebServerSpan(tags)) {
          webTags = tags
        } else {
          // Get parent's context's web tags
          const parentId = context._parentId
          for (let i = startedSpans.length; --i >= 0;) {
            const ispan = startedSpans[i]
            if (ispan.context()._spanId === parentId) {
              webTags = this._getProfilingContext(ispan).webTags
              break
            }
          }
        }
      }

      profilingContext = { spanId, rootSpanId, webTags }
      span[ProfilingContext] = profilingContext
    }
    return profilingContext
  }

  _setNewContext () {
    this._pprof.time.setContext(
      this._currentContext = {
        ref: {}
      }
    )
  }

  _updateContext (context) {
    if (typeof context.spanId === 'object') {
      context.spanId = context.spanId.toString(10)
    }
    if (typeof context.rootSpanId === 'object') {
      context.rootSpanId = context.rootSpanId.toString(10)
    }
    if (context.webTags !== undefined && context.endpoint === undefined) {
      // endpoint may not be determined yet, but keep it as fallback
      // if tags are not available anymore during serialization
      context.endpoint = endpointNameFromTags(context.webTags)
    }
  }

  _spanFinished (span) {
    if (span[ProfilingContext] !== undefined) {
      span[ProfilingContext] = undefined
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

    if (this._captureSpanData) {
      // update last sample context if needed
      this._enter()
      this._lastSampleCount = 0
    }
    const profile = this._pprof.time.stop(restart, this._generateLabels)

    if (restart) {
      const v8BugDetected = this._pprof.time.v8ProfilerStuckEventLoopDetected()
      if (v8BugDetected !== 0) {
        this._reportV8bug(v8BugDetected === 1)
      }
    } else {
      if (this._captureSpanData) {
        beforeCh.unsubscribe(this._enter)
        enterCh.unsubscribe(this._enter)
        spanFinishCh.unsubscribe(this._spanFinished)
        this._profilerState = undefined
      }
      this._started = false
    }

    return profile
  }

  _generateLabels ({ node, context }) {
    // check for special node that represents CPU time all non-JS threads.
    // In that case only return a special thread name label since we cannot associate any timestamp/span/endpoint to it.
    if (node.name === this._pprof.time.constants.NON_JS_THREADS_FUNCTION_NAME) {
      return getNonJSThreadsLabels()
    }

    if (context == null) {
      // generateLabels is also called for samples without context.
      // In that case just return thread labels.
      return getThreadLabels()
    }

    const labels = { ...getThreadLabels() }

    const { context: { ref }, timestamp } = context
    const { spanId, rootSpanId, webTags, endpoint } = ref ?? {}

    if (this._timelineEnabled) {
      // Incoming timestamps are in microseconds, we emit nanos.
      labels[END_TIMESTAMP_LABEL] = timestamp * 1000n
    }

    if (spanId !== undefined) {
      labels[SPAN_ID_LABEL] = spanId
    }
    if (rootSpanId !== undefined) {
      labels[LOCAL_ROOT_SPAN_ID_LABEL] = rootSpanId
    }
    if (webTags !== undefined && Object.keys(webTags).length !== 0) {
      labels['trace endpoint'] = endpointNameFromTags(webTags)
    } else if (endpoint) {
      // fallback to endpoint computed when sample was taken
      labels['trace endpoint'] = endpoint
    }

    return labels
  }

  profile (restart) {
    return this._stop(restart)
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    this._stop(false)
  }

  isStarted () {
    return this._started
  }
}

module.exports = NativeWallProfiler
