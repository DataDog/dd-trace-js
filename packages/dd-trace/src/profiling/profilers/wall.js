'use strict'

const log = require('../../log')
const runtimeMetrics = require('../../runtime_metrics')
const telemetryMetrics = require('../../telemetry/metrics')
const { endpointNameFromTags, finalEndpoint, getStartedSpans } = require('../webspan-utils')
const { SAMPLING_INTERVAL } = require('../constants')
const {
  enterCh,
  beforeCh,
  spanFinishCh,
  getActiveSpan,
  acquireChannels,
  releaseChannels,
} = require('../../storage-channels')
const webTagsCache = require('../../web-tags-cache')

const {
  END_TIMESTAMP_LABEL,
  SPAN_ID_LABEL,
  LOCAL_ROOT_SPAN_ID_LABEL,
  TRACE_ID_LABEL,
  getNonJSThreadsLabels,
  getNonJSThreadsOtelLabels,
  getOtelThreadLabels,
  getThreadLabels,
} = require('./shared')
const TRACE_ENDPOINT_LABEL = 'trace endpoint'

/** @typedef {import('../../config/config-base')} TracerConfig */
/** @typedef {import('@datadog/pprof').CapturedProfile} CapturedProfile */

const profilerTelemetryMetrics = telemetryMetrics.manager.namespace('profilers')

const ProfilingContext = Symbol('NativeWallProfiler.ProfilingContext')

let kSampleCount

/**
 * The profiling context of a span, as samples carry it.
 *
 * @typedef {{
 *   spanId?: unknown,
 *   rootSpanId?: unknown,
 *   traceIdLow?: import('../../id').Identifier,
 *   traceIdHigh?: string,
 *   traceId?: bigint,
 *   webTags?: Record<string, unknown>,
 *   endpoint?: string,
 * }} ProfilingContext
 *
 * With OTLP export, a span's trace ID is kept as its identifier and the hex of its upper 64 bits, as the span context
 * has them, and only combined into traceId when a sample needs it.
 */

// The tag of the hex of a 128-bit trace ID's upper 64 bits, when the span context's identifier only has the lower 64
const TRACE_ID_128 = '_dd.p.tid'
const HEX_64 = /^[\da-f]{16}$/i

function toBigInt (spanId) {
  return spanId !== null && typeof spanId === 'object' ? spanId.toBigInt() : spanId
}

/**
 * A trace ID as a bigint, from the span context's identifier and the hex of the upper 64 bits, as its toTraceId(true)
 * would have it, but without going through hex for the identifier.
 *
 * @param {import('../../id').Identifier} traceId
 * @param {string | undefined} traceIdHigh
 */
function toTraceIdBigInt (traceId, traceIdHigh) {
  const buffer = traceId.toBuffer()
  if (buffer.length > 8) {
    // A 128-bit identifier has its upper 64 bits itself
    const bytes = Buffer.from(buffer)
    return (bytes.readBigUInt64BE(bytes.length - 16) << 64n) | bytes.readBigUInt64BE(bytes.length - 8)
  }
  const low = traceId.toBigInt()
  return traceIdHigh !== undefined && HEX_64.test(traceIdHigh) ? (BigInt(`0x${traceIdHigh}`) << 64n) | low : low
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
    // if tags are not available anymore during serialization. Only snapshot a
    // settled value: routing tags land over the course of the request, and this
    // field is never refreshed once set, so capturing an interim placeholder
    // (a bare `GET`) would pin the fallback to it. Staying undefined until then
    // just means the next sample rotation tries again.
    context.endpoint = finalEndpoint(context.webTags)
  }
}

class NativeWallProfiler {
  #asyncContextFrameEnabled = false
  #captureSpanData = false
  #codeHotspotsEnabled = false
  #otlp = false
  #contextCountGaugeUpdater
  collectsCpuTime = false
  #currentContext
  #customLabelsActive = false
  #customLabelKeys
  #endpointCollectionEnabled = false
  #flushIntervalMillis = 0
  #lastSampleCount = 0
  #mapper
  #pprof
  #profilerState
  #samplingIntervalMicros = 0
  #started = false
  #telemetryHeartbeatIntervalMillis = 0
  #timelineEnabled = false
  #v8ProfilerBugWorkaroundEnabled = false
  #withContexts = false

  // Bind these to this so they can be used as callbacks
  #boundEnter = this.#enter.bind(this)
  #boundSpanFinished = this.#spanFinished.bind(this)
  #boundSpanTagsUpdated = this.#spanTagsUpdated.bind(this)
  #boundGenerateLabels = this._generateLabels.bind(this)
  #boundGenerateOtelLabels = this.#generateOtelLabels.bind(this)

  get type () { return 'wall' }

  /**
   * @param {TracerConfig} config
   * @param {{ asyncContextFrameEnabled: boolean, flushInterval: number }} runtime
   */
  constructor (config, { asyncContextFrameEnabled, flushInterval }) {
    this.#asyncContextFrameEnabled = asyncContextFrameEnabled
    this.#codeHotspotsEnabled = config.DD_PROFILING_CODEHOTSPOTS_ENABLED
    this.#otlp = config.OTEL_PROFILES_EXPORTER === 'otlp'
    this.collectsCpuTime = config.DD_PROFILING_CPU_ENABLED
    this.#endpointCollectionEnabled = config.DD_PROFILING_ENDPOINT_COLLECTION_ENABLED
    this.#flushIntervalMillis = flushInterval
    this.#samplingIntervalMicros = SAMPLING_INTERVAL * 1000
    this.#telemetryHeartbeatIntervalMillis = config.telemetry.DD_TELEMETRY_HEARTBEAT_INTERVAL
    this.#timelineEnabled = config.DD_PROFILING_TIMELINE_ENABLED
    this.#v8ProfilerBugWorkaroundEnabled = config.DD_PROFILING_V8_PROFILER_BUG_WORKAROUND

    // We need to capture span data into the sample context for either code hotspots
    // or endpoint collection.
    this.#captureSpanData = this.#codeHotspotsEnabled || this.#endpointCollectionEnabled
    // We need to run the pprof wall profiler with sample contexts if we're either
    // capturing span data or timeline is enabled (so we need sample timestamps, and for now
    // timestamps require the sample contexts feature in the pprof wall profiler), or
    // cpu profiling is enabled.
    this.#withContexts = this.#captureSpanData || this.#timelineEnabled || this.collectsCpuTime
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

    this.#pprof.time.start({
      collectCpuTime: this.collectsCpuTime,
      columnNumbers: 'emit',
      durationMillis: this.#flushIntervalMillis,
      intervalMicros: this.#samplingIntervalMicros,
      lineNumbers: false,
      sourceMapper: this.#mapper,
      useCPED: this.#asyncContextFrameEnabled,
      withContexts: this.#withContexts,
      workaroundV8Bug: this.#v8ProfilerBugWorkaroundEnabled,
    })

    if (this.#withContexts) {
      if (!this.#asyncContextFrameEnabled) {
        this.#setNewContext()
      }

      if (this.#captureSpanData) {
        this.#profilerState = this.#pprof.time.getState()
        this.#lastSampleCount = 0

        acquireChannels(!this.#asyncContextFrameEnabled)

        if (this.#asyncContextFrameEnabled) {
          this.#setupTelemetryMetrics()
        } else {
          beforeCh.subscribe(this.#boundEnter)
        }
        enterCh.subscribe(this.#boundEnter)
        spanFinishCh.subscribe(this.#boundSpanFinished)
        if (this.#endpointCollectionEnabled) {
          // Web-tags cache publishes once per span at the moment its
          // walk-result changes — exactly when we need to refresh the
          // ProfilingContext snapshot.
          webTagsCache.resolvedCh.subscribe(this.#boundSpanTagsUpdated)
          // Turn on the cache's own tagsUpdate subscription — it's
          // ref-counted, so this composes with any other active consumer.
          webTagsCache.activate()
        }
      }
    }

    this.#started = true
  }

  #setupTelemetryMetrics () {
    const asyncContextsLiveGauge = profilerTelemetryMetrics.gauge('wall.async_contexts_live')
    const asyncContextsUsedGauge = profilerTelemetryMetrics.gauge('wall.async_contexts_used')

    this.#contextCountGaugeUpdater = setInterval(() => {
      const { totalAsyncContextCount, usedAsyncContextCount } = this.#pprof.time.getMetrics()
      asyncContextsLiveGauge.mark(totalAsyncContextCount)
      asyncContextsUsedGauge.mark(usedAsyncContextCount)
    }, this.#telemetryHeartbeatIntervalMillis)
    this.#contextCountGaugeUpdater.unref?.()
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
      const current = this.#pprof.time.getContext()
      if (this.#customLabelsActive) {
        // Custom labels may be active in this async context. The current CPED
        // context could be a 2-element array [profilingContext, customLabels].
        // Replace the profiling context while preserving the custom labels.
        // This flag is monotonic (once set, stays true) because async
        // continuations from runWithLabels can fire at any time after the
        // synchronous runWithLabels call has returned.
        if (Array.isArray(current)) {
          if (current[0] !== sampleContext) {
            this.#pprof.time.setContext([sampleContext, current[1]])
          }
        } else if (current !== sampleContext) {
          this.#pprof.time.setContext(sampleContext)
        }
      } else if (current !== sampleContext) {
        // Every setContext() call in ACF mode allocates a fresh contextHolder
        // (a node::ObjectWrap with its own v8::Global<v8::Value>) in the native
        // profiler. We're only incurring the cost when current !== sampleContext
        // and skip it when current === sampleContext, which is the common case
        // when the same span is repeatedly activated.
        this.#pprof.time.setContext(sampleContext)
      }
    } else {
      const sampleCount = this.#profilerState[kSampleCount]
      if (sampleCount !== this.#lastSampleCount) {
        this.#lastSampleCount = sampleCount
        const context = this.#currentContext.ref
        this.#setNewContext()

        updateContext(context)
      }

      this.#currentContext.ref = sampleContext
    }
  }

  #getProfilingContext (span) {
    let profilingContext = span[ProfilingContext]
    if (profilingContext === undefined) {
      const context = span.context()

      let spanId
      let rootSpanId
      let traceIdLow
      let traceIdHigh
      if (this.#codeHotspotsEnabled) {
        const startedSpans = getStartedSpans(context)
        spanId = context._spanId
        rootSpanId = startedSpans.length ? startedSpans[0].context()._spanId : context._spanId
        if (this.#otlp) {
          // OTLP samples link to their span by trace ID and span ID. Only references are kept here, as most spans
          // aren't in a sample: #generateOtelLabels makes the trace ID of those that are.
          traceIdLow = context._traceId
          traceIdHigh = context._trace.tags[TRACE_ID_128]
        }
      }

      // webTags is snapshotted into the sample context at getProfilingContext
      // time; if the answer changes later — the span or an ancestor becomes a
      // web-server span — #spanTagsUpdated refreshes this field via the shared
      // cache (see web-tags-cache.js).
      const webTags = this.#endpointCollectionEnabled ? webTagsCache.getCachedWebTags(span) : undefined

      profilingContext = traceIdLow === undefined
        ? { spanId, rootSpanId, webTags }
        : { spanId, rootSpanId, traceIdLow, traceIdHigh, webTags }
      span[ProfilingContext] = profilingContext
    }
    return profilingContext
  }

  #setNewContext () {
    this.#currentContext = {
      ref: {},
    }
    this.#pprof.time.setContext(this.#currentContext)
  }

  #spanFinished (span) {
    if (span[ProfilingContext] !== undefined) {
      span[ProfilingContext] = undefined
    }
  }

  // Invoked (via webTagsCache.resolvedCh) once per span at the moment the
  // shared cache changes its webTags answer: an empty one promoted into a real
  // value, or an outer request's tag bag replaced by a nearer one. Refresh the
  // ProfilingContext snapshot in place so samples already holding it — including
  // those of a span that stays active across the promotion — pick it up.
  #spanTagsUpdated (span) {
    if (!this.#started) return
    const profilingContext = span[ProfilingContext]
    if (profilingContext === undefined) return
    profilingContext.webTags = webTagsCache.getCachedWebTags(span)
  }

  #reportV8bug (maybeBug) {
    const tag = `v8_profiler_bug_workaround_enabled:${this.#v8ProfilerBugWorkaroundEnabled}`
    const metric = `v8_cpu_profiler${maybeBug ? '_maybe' : ''}_stuck_event_loop`
    log.warn('Wall profiler: %sv8 profiler stuck event loop detected.', maybeBug ? 'possible ' : '')
    // report as runtime metric (can be removed in the future when telemetry is mature)
    runtimeMetrics.increment(`runtime.node.profiler.${metric}`, tag, true)
    // report as telemetry metric
    profilerTelemetryMetrics.count(metric, [tag]).inc()
  }

  /**
   * @param {boolean} restart
   * @returns {CapturedProfile | undefined}
   */
  #stop (restart) {
    if (!this.#started) return

    if (this.#captureSpanData && !this.#asyncContextFrameEnabled) {
      // update last sample context if needed
      this.#enter()
      this.#lastSampleCount = 0
    }

    // Labels are generated when the profile is visited, in the format it's exported in
    const options = this.#otlp
      // Every sample with a context is a timestamped observation, as the timeline needs
      ? { generateLabels: this.#boundGenerateOtelLabels, samplePerContext: true }
      : { generateLabels: this.#boundGenerateLabels }
    const profile = this.#pprof.time.stopAndCapture(restart, options)

    if (restart) {
      const v8BugDetected = this.#pprof.time.v8ProfilerStuckEventLoopDetected()
      if (v8BugDetected !== 0) {
        this.#reportV8bug(v8BugDetected === 1)
      }
    } else {
      clearInterval(this.#contextCountGaugeUpdater)
      if (this.#captureSpanData) {
        if (!this.#asyncContextFrameEnabled) {
          beforeCh.unsubscribe(this.#boundEnter)
        }
        enterCh.unsubscribe(this.#boundEnter)
        spanFinishCh.unsubscribe(this.#boundSpanFinished)
        releaseChannels(!this.#asyncContextFrameEnabled)
        if (this.#endpointCollectionEnabled) {
          webTagsCache.resolvedCh.unsubscribe(this.#boundSpanTagsUpdated)
          webTagsCache.deactivate()
        }
        this.#profilerState = undefined
      }
      this.#started = false
    }

    return profile
  }

  /**
   * Returns a sample context's profiling context: the span's, if any. Native profiler doesn't set context.context for
   * some samples, such as idle samples or when the context was otherwise unavailable when the sample was taken. With
   * ACF, there is no "ref" indirection, and when custom labels are active, context.context is a 2-element array:
   * [profilingContext, customLabels]. Otherwise it's a plain object.
   *
   * @param {{ context?: unknown }} context
   * @returns {ProfilingContext | undefined}
   */
  #profilingContextOf (context) {
    const cctx = context.context
    if (this.#asyncContextFrameEnabled) {
      return Array.isArray(cctx) ? cctx[0] : cctx
    }
    return cctx?.ref
  }

  /**
   * The labels of an OTLP sample: the thread's, as semantic-convention attributes, and the span's trace and span IDs,
   * which become the sample's link in the profiles builder. Its time is a sample timestamp, not a label.
   *
   * @param {{ node: { name: string }, context?: { context?: unknown } }} sample
   */
  #generateOtelLabels ({ node, context }) {
    if (node.name === this.#pprof.time.constants.NON_JS_THREADS_FUNCTION_NAME) {
      return getNonJSThreadsOtelLabels()
    }
    const ref = context == null ? undefined : this.#profilingContextOf(context)
    if (typeof ref !== 'object') {
      return getOtelThreadLabels()
    }
    const { spanId, traceIdLow } = ref
    if (spanId === undefined || traceIdLow === undefined) {
      return getOtelThreadLabels()
    }
    // The trace ID is made once for each span in the samples
    const labels = { ...getOtelThreadLabels(), [SPAN_ID_LABEL]: toBigInt(spanId) }
    labels[TRACE_ID_LABEL] = ref.traceId ??= toTraceIdBigInt(traceIdLow, ref.traceIdHigh)
    return labels
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

    // Native profiler doesn't set context.context for some samples, such as idle samples or when
    // the context was otherwise unavailable when the sample was taken. Note that with ACF, we don't
    // use the "ref" indirection.
    let ref
    let customLabels
    const cctx = context.context
    if (this.#asyncContextFrameEnabled) {
      // When custom labels are active with ACF, context.context is a 2-element array:
      // [profilingContext, customLabels]. Otherwise it's a plain object.
      if (Array.isArray(cctx)) {
        [ref, customLabels] = cctx
      } else {
        ref = cctx
      }
    } else {
      ref = cctx?.ref
    }

    // Custom labels are spread first so that internal labels always take
    // precedence and overwrite them.
    const labels = customLabels === undefined
      ? { ...getThreadLabels() }
      : { ...customLabels, ...getThreadLabels() }

    if (this.#timelineEnabled) {
      // Incoming timestamps are in microseconds, we emit nanos.
      labels[END_TIMESTAMP_LABEL] = context.timestamp * 1000n
    }

    const asyncId = context.asyncId
    if (asyncId !== undefined && asyncId !== -1) {
      labels['async id'] = asyncId
    }

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
    if (webTags !== undefined) {
      labels[TRACE_ENDPOINT_LABEL] = endpointNameFromTags(webTags)
    } else if (endpoint) {
      // fallback to endpoint computed when sample was taken
      labels[TRACE_ENDPOINT_LABEL] = endpoint
    }

    return labels
  }

  /**
   * Sets the custom label keys used for pprof low-cardinality deduplication.
   * Called once by the top-level Profiler when keys are declared.
   *
   * @param {Iterable<string>} keys
   */
  setCustomLabelKeys (keys) {
    this.#customLabelKeys = keys
  }

  /**
   * Runs a function with custom profiling labels attached to all wall profiler
   * samples taken during its execution. Labels are key-value pairs that appear
   * in the pprof output and can be used to filter flame graphs in the Datadog UI.
   *
   * Requires AsyncContextFrame (ACF) to be enabled. Supports nesting: inner
   * calls merge labels with outer calls, with inner values taking precedence.
   *
   * @param {Record<string, string | number>} labels - Custom labels to attach
   * @param {function(): T} fn - Function to execute with the labels
   * @returns {T} The return value of fn
   * @template T
   */
  runWithLabels (labels, fn) {
    if (!this.#asyncContextFrameEnabled || !this.#withContexts) {
      return fn()
    }

    // Read current context; merge custom labels if already in a runWithLabels scope
    const current = this.#pprof.time.getContext()
    const isCurrentArray = Array.isArray(current)
    const customLabels = isCurrentArray ? { ...current[1], ...labels } : labels

    const profilingContext = (isCurrentArray ? current[0] : current) ?? {}

    this.#customLabelsActive = true
    return this.#pprof.time.runWithContext([profilingContext, customLabels], fn)
  }

  /**
   * @param {boolean} restart
   * @returns {CapturedProfile | undefined}
   */
  capture (restart) {
    return this.#stop(restart)
  }

  /**
   * How pprof profiles of the captured profiles are built: thread, trace endpoint and custom labels are
   * good deduplication candidates, and frames carry their column only for server-side unminification.
   *
   * @returns {import('@datadog/pprof').PprofSerializerOptions}
   */
  get pprofBuilderOptions () {
    const lowCardinalityLabels = Object.keys(getThreadLabels())
    lowCardinalityLabels.push(TRACE_ENDPOINT_LABEL)
    // Custom labels are expected to be low-cardinality (e.g. customer tier, region)
    if (this.#customLabelKeys) {
      for (const key of this.#customLabelKeys) {
        lowCardinalityLabels.push(key)
      }
    }
    return { lowCardinalityLabels, columnNumbers: 'emit' }
  }

  getInfo () {
    const { totalAsyncContextCount, usedAsyncContextCount } = this.#pprof.time.getMetrics()
    return {
      totalAsyncContextCount,
      usedAsyncContextCount,
    }
  }

  stop () {
    this.#stop(false)
  }

  isStarted () {
    return this.#started
  }
}

module.exports = NativeWallProfiler
