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
  if (context.spanId !== undefined) {
    context.spanId = toBigInt(context.spanId)
  }
  if (context.rootSpanId !== undefined) {
    context.rootSpanId = toBigInt(context.rootSpanId)
  }
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
  #asyncContextFrameEnabled = false
  #captureSpanData = false
  #codeHotspotsEnabled = false
  #cpuProfilingEnabled = false
  #endpointCollectionEnabled = false
  #flushIntervalMillis = 0
  #logger
  #mapper
  #pprof
  #samplingIntervalMicros = 0
  #started = false
  #telemetryHeartbeatIntervalMillis = 0
  #timelineEnabled = false
  #v8ProfilerBugWorkaroundEnabled = false
  #withContexts = false

  // Bind these to this so they can be used as callbacks
  #boundEnter = this.#enter.bind(this)
  #boundSpanFinished = this.#spanFinished.bind(this)
  #boundGenerateLabels = this._generateLabels.bind(this)

  get type () { return 'wall' }

  constructor (options = {}) {
    this.#asyncContextFrameEnabled = !!options.asyncContextFrameEnabled
    this.#codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this.#cpuProfilingEnabled = !!options.cpuProfilingEnabled
    this.#endpointCollectionEnabled = !!options.endpointCollectionEnabled
    this.#flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this.#logger = options.logger
    // TODO: Remove default value. It is only used in testing.
    this.#samplingIntervalMicros = (options.samplingInterval || 1e3 / 99) * 1000
    this.#telemetryHeartbeatIntervalMillis = options.heartbeatInterval || 60 * 1e3 // 60 seconds
    this.#timelineEnabled = !!options.timelineEnabled
    this.#v8ProfilerBugWorkaroundEnabled = !!options.v8ProfilerBugWorkaroundEnabled

    // We need to capture span data into the sample context for either code hotspots
    // or endpoint collection.
    this.#captureSpanData = this.#codeHotspotsEnabled || this.#endpointCollectionEnabled
    // We need to run the pprof wall profiler with sample contexts if we're either
    // capturing span data or timeline is enabled (so we need sample timestamps, and for now
    // timestamps require the sample contexts feature in the pprof wall profiler), or
    // cpu profiling is enabled.
    this.#withContexts = this.#captureSpanData || this.#timelineEnabled || this.#cpuProfilingEnabled
  }

  codeHotspotsEnabled () {
    return this.#codeHotspotsEnabled
  }

  endpointCollectionEnabled () {
    return this.#endpointCollectionEnabled
  }

  start ({ mapper } = {}) {
    if (this.#started) return

    this.#mapper = mapper
    this.#pprof = require('@datadog/pprof')
    kSampleCount = this.#pprof.time.constants.kSampleCount

    // pprof otherwise crashes in worker threads
    if (!process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier = () => {}
    }
    if (!process._stopProfilerIdleNotifier) {
      process._stopProfilerIdleNotifier = () => {}
    }

    this.#pprof.time.start({
      collectCpuTime: this.#cpuProfilingEnabled,
      durationMillis: this.#flushIntervalMillis,
      intervalMicros: this.#samplingIntervalMicros,
      lineNumbers: false,
      sourceMapper: this.#mapper,
      useCPED: this.#asyncContextFrameEnabled,
      withContexts: this.#withContexts,
      workaroundV8Bug: this.#v8ProfilerBugWorkaroundEnabled
    })

    if (this.#withContexts) {
      if (!this.#asyncContextFrameEnabled) {
        this.#setNewContext()
      }

      if (this.#captureSpanData) {
        this._profilerState = this.#pprof.time.getState()
        this._lastSampleCount = 0

        ensureChannelsActivated(this.#asyncContextFrameEnabled)

        if (this.#asyncContextFrameEnabled) {
          this.#setupTelemetryMetrics()
        } else {
          beforeCh.subscribe(this.#boundEnter)
        }
        enterCh.subscribe(this.#boundEnter)
        spanFinishCh.subscribe(this.#boundSpanFinished)
      }
    }

    this.#started = true
  }

  #setupTelemetryMetrics () {
    const asyncContextsLiveGauge = profilerTelemetryMetrics.gauge('wall.async_contexts_live')
    const asyncContextsUsedGauge = profilerTelemetryMetrics.gauge('wall.async_contexts_used')

    this._contextCountGaugeUpdater = setInterval(() => {
      const { totalAsyncContextCount, usedAsyncContextCount } = this.#pprof.time.getMetrics()
      asyncContextsLiveGauge.mark(totalAsyncContextCount)
      asyncContextsUsedGauge.mark(usedAsyncContextCount)
    }, this.#telemetryHeartbeatIntervalMillis)
    this._contextCountGaugeUpdater.unref()
  }

  #enter () {
    if (!this.#started) return

    const span = getActiveSpan()
    const sampleContext = span ? this.#getProfilingContext(span) : {}

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
      this.#pprof.time.setContext(sampleContext)
    } else {
      const sampleCount = this._profilerState[kSampleCount]
      if (sampleCount !== this._lastSampleCount) {
        this._lastSampleCount = sampleCount
        const context = this._currentContext.ref
        this.#setNewContext()

        updateContext(context)
      }

      this._currentContext.ref = sampleContext
    }
  }

  #getProfilingContext (span) {
    let profilingContext = span[ProfilingContext]
    if (profilingContext === undefined) {
      const context = span.context()
      const startedSpans = getStartedSpans(context)

      let spanId
      let rootSpanId
      if (this.#codeHotspotsEnabled) {
        spanId = context._spanId
        rootSpanId = startedSpans.length ? startedSpans[0].context()._spanId : context._spanId
      }

      let webTags
      if (this.#endpointCollectionEnabled) {
        const tags = context._tags
        if (isWebServerSpan(tags)) {
          webTags = tags
        } else {
          // Get parent's context's web tags
          const parentId = context._parentId
          for (let i = startedSpans.length; --i >= 0;) {
            const ispan = startedSpans[i]
            if (ispan.context()._spanId === parentId) {
              webTags = this.#getProfilingContext(ispan).webTags
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

  #setNewContext () {
    this.#pprof.time.setContext(
      this._currentContext = {
        ref: {}
      }
    )
  }

  #spanFinished (span) {
    if (span[ProfilingContext] !== undefined) {
      span[ProfilingContext] = undefined
    }
  }

  #reportV8bug (maybeBug) {
    const tag = `v8_profiler_bug_workaround_enabled:${this.#v8ProfilerBugWorkaroundEnabled}`
    const metric = `v8_cpu_profiler${maybeBug ? '_maybe' : ''}_stuck_event_loop`
    this.#logger?.warn(`Wall profiler: ${maybeBug ? 'possible ' : ''}v8 profiler stuck event loop detected.`)
    // report as runtime metric (can be removed in the future when telemetry is mature)
    runtimeMetrics.increment(`runtime.node.profiler.${metric}`, tag, true)
    // report as telemetry metric
    profilerTelemetryMetrics.count(metric, [tag]).inc()
  }

  #stop (restart) {
    if (!this.#started) return

    if (this.#captureSpanData && !this.#asyncContextFrameEnabled) {
      // update last sample context if needed
      this.#enter()
      this._lastSampleCount = 0
    }

    // Mark thread labels and trace endpoint label as good deduplication candidates
    const lowCardinalityLabels = Object.keys(getThreadLabels())
    lowCardinalityLabels.push(TRACE_ENDPOINT_LABEL)

    const profile = this.#pprof.time.stop(restart, this.#boundGenerateLabels, lowCardinalityLabels)

    if (restart) {
      const v8BugDetected = this.#pprof.time.v8ProfilerStuckEventLoopDetected()
      if (v8BugDetected !== 0) {
        this.#reportV8bug(v8BugDetected === 1)
      }
    } else {
      clearInterval(this._contextCountGaugeUpdater)
      if (this.#captureSpanData) {
        if (!this.#asyncContextFrameEnabled) {
          beforeCh.unsubscribe(this.#boundEnter)
        }
        enterCh.unsubscribe(this.#boundEnter)
        spanFinishCh.unsubscribe(this.#boundSpanFinished)
        this._profilerState = undefined
      }
      this.#started = false
    }

    return profile
  }

  _generateLabels ({ node, context }) {
    // check for special node that represents CPU time all non-JS threads.
    // In that case only return a special thread name label since we cannot associate any timestamp/span/endpoint to it.
    if (node.name === this.#pprof.time.constants.NON_JS_THREADS_FUNCTION_NAME) {
      return getNonJSThreadsLabels()
    }

    if (context == null) {
      // generateLabels is also called for samples without context.
      // In that case just return thread labels.
      return getThreadLabels()
    }

    const labels = { ...getThreadLabels() }

    if (this.#timelineEnabled) {
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
    return this.#stop(restart)
  }

  getInfo () {
    const { totalAsyncContextCount, usedAsyncContextCount } = this.#pprof.time.getMetrics()
    return {
      totalAsyncContextCount,
      usedAsyncContextCount
    }
  }

  encode (profile) {
    return encodeProfileAsync(profile)
  }

  stop () {
    this.#stop(false)
  }

  isStarted () {
    return this.#started
  }
}

module.exports = NativeWallProfiler
