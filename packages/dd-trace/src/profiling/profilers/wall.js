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
  getThreadLabels,
  encodeProfileAsync
} = require('./shared')
const TRACE_ENDPOINT_LABEL = 'trace endpoint'

const { isWebServerSpan, endpointNameFromTags, getStartedSpans } = require('../webspan-utils')

let beforeCh
const enterCh = dc.channel('dd-trace:storage:enter')
const spanFinishCh = dc.channel('dd-trace:span:finish')
const profilerTelemetryMetrics = telemetryMetrics.manager.namespace('profilers')

const ProfilingContext = Symbol('NativeWallProfiler.ProfilingContext')

let kSampleCount
let kCPEDContextCount

function getActiveSpan () {
  const store = storage('legacy').getStore()
  return store && store.span
}

function toBigInt (spanId) {
  return spanId !== null && typeof spanId === 'object' ? spanId.toBigInt() : spanId
}

function updateContext (context) {
  // Converting spanIDs to bigints is not necessary as generateLabels will do it
  // too. When we don't use async context frame, we can convert them when the
  // sample is taken though so we amortize the latency of operations. It is an
  // optimization.
  context.spanId = toBigInt(context.spanId)
  context.rootSpanId = toBigInt(context.rootSpanId)
  if (context.webTags !== undefined && context.endpoint === undefined) {
    // endpoint may not be determined yet, but keep it as fallback
    // if tags are not available anymore during serialization
    context.endpoint = endpointNameFromTags(context.webTags)
  }
}

let channelsActivated = false
function ensureChannelsActivated (asyncContextFrameEnabled) {
  if (channelsActivated) return

  const shimmer = require('../../../../datadog-shimmer')
  const asyncHooks = require('async_hooks')

  // When using AsyncContextFrame to store sample context, we do not need to use
  // async_hooks.createHook to create a "before" callback anymore.
  if (!asyncContextFrameEnabled) {
    const { createHook } = asyncHooks
    beforeCh = dc.channel('dd-trace:storage:before')
    createHook({ before: () => beforeCh.publish() }).enable()
  }

  const { AsyncLocalStorage } = asyncHooks

  // We need to instrument AsyncLocalStorage.enterWith() both with and without AsyncContextFrame.
  let inRun = false
  shimmer.wrap(AsyncLocalStorage.prototype, 'enterWith', function (original) {
    return function (...args) {
      const retVal = original.apply(this, args)
      if (!inRun) enterCh.publish()
      return retVal
    }
  })

  // We only need to instrument AsyncLocalStorage.run() when not using AsyncContextFrame.
  // AsyncContextFrame-based implementation of AsyncLocalStorage.run() delegates
  // to AsyncLocalStorage.enterWith() so it doesn't need to be separately instrumented.
  if (!asyncContextFrameEnabled) {
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
  }

  channelsActivated = true
}

class NativeWallProfiler {
  type = 'wall'
  _mapper
  _pprof
  _started = false
  #asyncContextFrameEnabled = false
  #telemetryHeartbeatIntervalMillis = 0

  constructor (options = {}) {
    this._samplingIntervalMicros = (options.samplingInterval || 1e3 / 99) * 1000 // 99hz
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._endpointCollectionEnabled = !!options.endpointCollectionEnabled
    this._timelineEnabled = !!options.timelineEnabled
    this._cpuProfilingEnabled = !!options.cpuProfilingEnabled
    this.#asyncContextFrameEnabled = !!options.asyncContextFrameEnabled
    this.#telemetryHeartbeatIntervalMillis = options.heartbeatInterval || 60 * 1e3 // 60 seconds

    // We need to capture span data into the sample context for either code hotspots
    // or endpoint collection.
    this._captureSpanData = this._codeHotspotsEnabled || this._endpointCollectionEnabled
    // We need to run the pprof wall profiler with sample contexts if we're either
    // capturing span data or timeline is enabled (so we need sample timestamps, and for now
    // timestamps require the sample contexts feature in the pprof wall profiler), or
    // cpu profiling is enabled.
    this._withContexts = this._captureSpanData || this._timelineEnabled || this._cpuProfilingEnabled
    this._v8ProfilerBugWorkaroundEnabled = !!options.v8ProfilerBugWorkaroundEnabled

    // Bind these to this so they can be used as callbacks
    if (this._withContexts && this._captureSpanData) {
      this._enter = this._enter.bind(this)
      this._spanFinished = this._spanFinished.bind(this)
    }
    this._generateLabels = this._generateLabels.bind(this)

    this._logger = options.logger
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
    kCPEDContextCount = this._pprof.time.constants.kCPEDContextCount

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
      collectCpuTime: this._cpuProfilingEnabled,
      useCPED: this.#asyncContextFrameEnabled
    })

    if (this._withContexts) {
      if (!this.#asyncContextFrameEnabled) {
        this._setNewContext()
      }

      if (this._captureSpanData) {
        this._profilerState = this._pprof.time.getState()
        this._lastSampleCount = 0

        ensureChannelsActivated(this.#asyncContextFrameEnabled)

        if (this.#asyncContextFrameEnabled) {
          this.#setupTelemetryMetrics()
        } else {
          beforeCh.subscribe(this._enter)
        }
        enterCh.subscribe(this._enter)
        spanFinishCh.subscribe(this._spanFinished)
      }
    }

    this._started = true
  }

  #setupTelemetryMetrics () {
    const contextCountGauge = profilerTelemetryMetrics.gauge('wall.sample_contexts')

    const that = this
    this._contextCountGaugeUpdater = setInterval(() => {
      contextCountGauge.mark(that._profilerState[kCPEDContextCount])
    }, that.#telemetryHeartbeatIntervalMillis)
    this._contextCountGaugeUpdater.unref()
  }

  _enter () {
    if (!this._started) return

    const span = getActiveSpan()
    const sampleContext = span ? this._getProfilingContext(span) : {}

    // Note that we store the sample context differently with and without the
    // async context frame. With the async context frame, we tell the profiler
    // to store the sample context directly in the frame on each enterWith.
    // Without the async context frame, we store one holder object as the
    // profiler's single sample context, and reassign its "ref" property on
    // every async context change. Then when we detect that the profiler took a
    // sample (and thus bound the holder as that sample's context), we create a
    // new holder object so that we no longer mutate the old one. This is really
    // an optimization to avoid going to profiler's native SetContext every
    // time. With async context frame however, we can't have that optimization,
    // as we can't tell from which async context frame was the sampling context
    // taken. For the same reason we can't call updateContext() on the old
    // context -- we simply can't tell which one it might've been across all
    // possible async context frames.
    if (this.#asyncContextFrameEnabled) {
      this._pprof.time.setContext(sampleContext)
    } else {
      const sampleCount = this._profilerState[kSampleCount]
      if (sampleCount !== this._lastSampleCount) {
        this._lastSampleCount = sampleCount
        const context = this._currentContext.ref
        this._setNewContext()

        updateContext(context)
      }

      this._currentContext.ref = sampleContext
    }
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

    if (this._captureSpanData && !this.#asyncContextFrameEnabled) {
      // update last sample context if needed
      this._enter()
      this._lastSampleCount = 0
    }

    // Mark thread labels and trace endpoint label as good deduplication candidates
    const lowCardinalityLabels = Object.keys(getThreadLabels())
    lowCardinalityLabels.push(TRACE_ENDPOINT_LABEL)

    const profile = this._pprof.time.stop(restart, this._generateLabels, lowCardinalityLabels)

    if (restart) {
      const v8BugDetected = this._pprof.time.v8ProfilerStuckEventLoopDetected()
      if (v8BugDetected !== 0) {
        this._reportV8bug(v8BugDetected === 1)
      }
    } else {
      clearInterval(this._contextCountGaugeUpdater)
      if (this._captureSpanData) {
        if (!this.#asyncContextFrameEnabled) {
          beforeCh.unsubscribe(this._enter)
        }
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

    if (this._timelineEnabled) {
      // Incoming timestamps are in microseconds, we emit nanos.
      labels[END_TIMESTAMP_LABEL] = context.timestamp * 1000n
    }

    const asyncId = context.asyncId
    if (asyncId !== undefined && asyncId !== -1) {
      labels['async id'] = asyncId
    }

    // Native profiler doesn't set context.context for some samples, such as idle samples or when
    // the context was otherwise unavailable when the sample was taken. Note that with async context
    // frame, we don't use the "ref" indirection.
    const ref = this.#asyncContextFrameEnabled ? context.context : context.context?.ref
    if (typeof ref !== 'object') {
      return labels
    }

    const { spanId, rootSpanId, webTags, endpoint } = ref

    if (spanId !== undefined) {
      labels[SPAN_ID_LABEL] = toBigInt(spanId)
    }
    if (rootSpanId !== undefined) {
      labels[LOCAL_ROOT_SPAN_ID_LABEL] = toBigInt(rootSpanId)
    }
    if (webTags !== undefined && Object.keys(webTags).length !== 0) {
      labels[TRACE_ENDPOINT_LABEL] = endpointNameFromTags(webTags)
    } else if (endpoint) {
      // fallback to endpoint computed when sample was taken
      labels[TRACE_ENDPOINT_LABEL] = endpoint
    }

    return labels
  }

  profile (restart) {
    return this._stop(restart)
  }

  encode (profile) {
    return encodeProfileAsync(profile)
  }

  stop () {
    this._stop(false)
  }

  isStarted () {
    return this._started
  }
}

module.exports = NativeWallProfiler
