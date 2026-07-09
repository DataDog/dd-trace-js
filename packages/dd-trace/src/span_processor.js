'use strict'

const { AUTO_KEEP } = require('../../../ext/priority')
const log = require('./log')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const native = require('./native')
const { registerExtraService } = require('./service-naming/extra-services')
const {
  SAMPLING_MECHANISM_MANUAL,
  SAMPLING_RULE_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_AGENT_DECISION,
  DECISION_MAKER_KEY,
  ORIGIN_KEY,
} = require('./constants')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

class SpanProcessor {
  constructor (exporter, prioritySampler, config, nativeSpans) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
    this._config = config
    this._killAll = false
    this._nativeSpans = nativeSpans

    this._spanSampler = new SpanSampler({ spanSamplingRules: config.sampler?.spanSamplingRules, nativeSpans })
    this._gitMetadataTagger = new GitMetadataTagger(config)
  }

  sample (span) {
    const spanContext = span.context()

    this._sampleNative(span, spanContext)

    // Single span sampling always runs in JS
    this._spanSampler.sample(spanContext)
  }

  /**
   * Perform sampling in native mode.
   *
   * Sampling itself runs JS-side: manual overrides are evaluated first via
   * `_getPriorityFromTags`, otherwise the standard JS priority sampler runs.
   * The decision is then mirrored into native storage so the WASM exporter
   * sees the same priority/mechanism the JS path observes.
   *
   * @param {object} span - The span to sample
   * @param {object} spanContext - The span's context
   * @private
   */
  _sampleNative (span, spanContext) {
    const root = spanContext._trace.started[0]

    if (!root) return // noop span

    // Decide a priority only if one hasn't been set yet. A priority may already
    // be set before the span is processed — AppSec force-keep, a manual
    // keep/drop via the API, or a value propagated from upstream — in which case
    // we keep it but still mirror it into native storage below. (Previously an
    // early return here skipped that sync, so those traces reached the exporter
    // without `_sampling_priority_v1`.)
    if (spanContext._sampling.priority === undefined) {
      // Check for manual override tags first (stays in JS)
      const manualPriority = this._prioritySampler._getPriorityFromTags(
        spanContext.getTags(),
        spanContext
      )

      if (this._prioritySampler.validate(manualPriority)) {
        // Manual override - set in JS context
        spanContext._sampling.priority = manualPriority
        spanContext._sampling.mechanism = SAMPLING_MECHANISM_MANUAL
      } else {
        // Use JS-side sampling
        this._prioritySampler.sample(spanContext)
      }
    }

    // Mirror the sampling decision (however it was made) into native storage so
    // the WASM exporter emits `_sampling_priority_v1` (+ `_dd.p.dm`).
    if (spanContext._nativeSpanId !== undefined) {
      this._syncSamplingToNative(spanContext, spanContext._nativeSpanId)
    }

    // Add decision maker tag
    this._addDecisionMaker(root)
  }

  /**
   * Sync the trace-level tags (chunk/propagation tags such as `_dd.p.tid` and
   * `_dd.p.dm`) into native storage. String tags become trace meta, finite
   * numbers become trace metrics. `_addDecisionMaker` (run inside sample(),
   * before this) has already set/cleared `_dd.p.dm` on `trace.tags`, so it is
   * the single source of truth here — crucially including extracted distributed
   * traces, whose `_dd.p.dm` arrives on `trace.tags` with no local sampling
   * mechanism set.
   *
   * @param {object} spanContext - The span context
   * @param {number} spanId - The native span id (op handle)
   * @private
   */
  _syncTraceTagsToNative (spanContext, spanId) {
    const traceTags = spanContext._trace.tags
    for (const key of Object.keys(traceTags)) {
      const value = traceTags[key]
      if (typeof value === 'string') {
        this._nativeSpans.queueOp(native.OpCode.SetTraceMetaAttr, spanId, key, value)
      } else if (typeof value === 'number' && !Number.isNaN(value)) {
        this._nativeSpans.queueOp(native.OpCode.SetTraceMetricsAttr, spanId, key, ['f64', value])
      }
    }

    // The JS formatter stamped `_dd.origin` (the trace's distributed origin,
    // e.g. `synthetics`) on the chunk root's meta. It lives on `_trace.origin`,
    // not in `_trace.tags`, so mirror it as trace meta here.
    const origin = spanContext._trace.origin
    if (typeof origin === 'string') {
      this._nativeSpans.queueOp(native.OpCode.SetTraceMetaAttr, spanId, ORIGIN_KEY, origin)
    }
  }

  /**
   * Sync sampling decision from JS to native storage.
   *
   * @param {object} spanContext - The span context
   * @param {number} spanId - The native span id (op handle)
   * @private
   */
  _syncSamplingToNative (spanContext, spanId) {
    // Sync priority as trace metric
    this._nativeSpans.queueOp(
      native.OpCode.SetTraceMetricsAttr,
      spanId,
      '_sampling_priority_v1',
      ['f64', spanContext._sampling.priority]
    )

    // `_dd.p.dm` is NOT emitted here: `_addDecisionMaker` sets/clears it on
    // `trace.tags` (honoring an extracted value, adding the local mechanism for
    // kept traces, deleting it for drops) and `_syncTraceTagsToNative` mirrors
    // it. Emitting it here too would duplicate it and miss extracted traces
    // whose mechanism is unset.

    // Forward sampling-decision metrics written by priority_sampler.js
    // Previously span_format.js copied these from _trace[KEY] onto root spans.
    const traceObj = spanContext._trace
    if (typeof traceObj[SAMPLING_RULE_DECISION] === 'number') {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetricsAttr,
        spanId,
        SAMPLING_RULE_DECISION,
        ['f64', traceObj[SAMPLING_RULE_DECISION]]
      )
    }
    if (typeof traceObj[SAMPLING_LIMIT_DECISION] === 'number') {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetricsAttr,
        spanId,
        SAMPLING_LIMIT_DECISION,
        ['f64', traceObj[SAMPLING_LIMIT_DECISION]]
      )
    }
    if (typeof traceObj[SAMPLING_AGENT_DECISION] === 'number') {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetricsAttr,
        spanId,
        SAMPLING_AGENT_DECISION,
        ['f64', traceObj[SAMPLING_AGENT_DECISION]]
      )
    }
  }

  /**
   * Add decision maker trace tag when priority is keep.
   *
   * @param {object} span - The root span
   * @private
   */
  _addDecisionMaker (span) {
    const context = span.context()
    const trace = context._trace
    const priority = context._sampling.priority
    const mechanism = context._sampling.mechanism

    // Only kept traces (priority >= AUTO_KEEP, where AUTO_KEEP === 1) carry the
    // decision-maker tag; the legacy priority sampler omits it for auto-reject
    // (0) and manual-drop (-1).
    if (priority >= AUTO_KEEP) {
      if (!trace.tags[DECISION_MAKER_KEY] && mechanism !== undefined) {
        trace.tags[DECISION_MAKER_KEY] = `-${mechanism}`
      }
    } else if (DECISION_MAKER_KEY in trace.tags) {
      // Guard the `delete` so the common drop path doesn't pay the V8
      // dictionary-mode transition unless a prior keep decision actually
      // set the tag.
      delete trace.tags[DECISION_MAKER_KEY]
    }
  }

  process (span) {
    const spanContext = span.context()
    const active = []
    const trace = spanContext._trace
    const { flushMinSpans, DD_TRACE_ENABLED } = this._config
    const { started, finished } = trace

    if (trace.record === false) return
    if (DD_TRACE_ENABLED === false) {
      this._erase(trace, active)
      return
    }
    if (started.length === finished.length || finished.length >= flushMinSpans) {
      this.sample(span)
      this._gitMetadataTagger.tagGitMetadata(spanContext)

      // Mirror trace-level tags (`_dd.p.tid`, other `_dd.p.*`, `baggage.*`, and
      // the git metadata tagged just above) into native storage now that all
      // trace tags are set — tagGitMetadata runs after sample(), so this must
      // come after it. `_dd.p.dm` is handled by the sampling path.
      if (spanContext._nativeSpanId !== undefined) {
        this._syncTraceTagsToNative(spanContext, spanContext._nativeSpanId)
      }

      // Pass raw spans to the native exporter; the WASM pipeline serializes
      // them. When native stats are enabled the concentrator handles stats
      // aggregation during flush_chunk.
      const finishedSpansToExport = []
      const otelSemantics = this._config.DD_TRACE_OTEL_SEMANTICS_ENABLED

      for (const span of started) {
        if (span._duration === undefined) {
          active.push(span)
        } else {
          finishedSpansToExport.push(span)
          const context = span.context()
          // Remap Datadog HTTP tags to OpenTelemetry names on the native span
          // before export. Done at finish (not per setTag) because the remap
          // needs the full tag set (URL decomposition, status -> error).
          if (otelSemantics && typeof context.applyOtelHttpSemantics === 'function') {
            context.applyOtelHttpSemantics()
          }
          const serviceName = context.getTag('service.name')
          if (typeof serviceName === 'string' && serviceName.length > 0) {
            registerExtraService(serviceName)
          }
        }
      }

      if (finishedSpansToExport.length !== 0 && trace.isRecording !== false) {
        this._exporter.export(finishedSpansToExport)
      }

      this._erase(trace, active)
    }

    if (this._killAll) {
      for (const startedSpan of started) {
        if (!startedSpan._finished) {
          startedSpan.finish()
        }
      }
    }
  }

  killAll () {
    this._killAll = true
  }

  _erase (trace, active) {
    if (this._config.DD_TRACE_EXPERIMENTAL_STATE_TRACKING) {
      const started = new Set()
      const startedIds = new Set()
      const finished = new Set()
      const finishedIds = new Set()

      for (const span of trace.finished) {
        const context = span.context()
        const id = context.toSpanId()

        if (finished.has(span)) {
          log.error('Span was already finished in the same trace: %s', span)
        } else {
          finished.add(span)

          if (finishedIds.has(id)) {
            log.error('Another span with the same ID was already finished in the same trace: %s', span)
          } else {
            finishedIds.add(id)
          }

          if (context._trace !== trace) {
            log.error('A span was finished in the wrong trace: %s', span)
          }

          if (finishedSpans.has(span)) {
            log.error('Span was already finished in a different trace: %s', span)
          } else {
            finishedSpans.add(span)
          }
        }
      }

      for (const span of trace.started) {
        const context = span.context()
        const id = context.toSpanId()

        if (started.has(span)) {
          log.error('Span was already started in the same trace: %s', span)
        } else {
          started.add(span)

          if (startedIds.has(id)) {
            log.error('Another span with the same ID was already started in the same trace: %s', span)
          } else {
            startedIds.add(id)
          }

          if (context._trace !== trace) {
            log.error('A span was started in the wrong trace: %s', span)
          }

          if (startedSpans.has(span)) {
            log.error('Span was already started in a different trace: %s', span)
          } else {
            startedSpans.add(span)
          }
        }

        if (!finished.has(span)) {
          log.error('Span started in one trace but was finished in another trace: %s', span)
        }
      }

      for (const span of trace.finished) {
        if (!started.has(span)) {
          log.error('Span finished in one trace but was started in another trace: %s', span)
        }
      }
    }

    trace.started = active
    trace.finished = []
  }
}

module.exports = SpanProcessor
