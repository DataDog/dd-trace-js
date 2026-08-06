'use strict'

const processTags = require('./process-tags')
const SpanProcessor = require('./span_processor')
const spanFormat = require('./span_format')
const { MAX_META_VALUE_LENGTH, normalizeSpan } = require('./encode/tags-processors')
const {
  APM_TRACING_ENABLED_KEY,
  ORIGIN_KEY,
  SAMPLING_AGENT_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_RULE_DECISION,
} = require('./constants')
const { OpCode } = require('./native')

/** Native serialization variant of the shared span processor. */
class NativeSpanProcessor extends SpanProcessor {
  /**
   * @param {object} exporter Native exporter
   * @param {object} prioritySampler Priority sampler
   * @param {object} config Tracer configuration
   * @param {import('./native/native_spans')} nativeSpans Native span storage
   * @param {object} [otlpStatsExporter] OTLP stats exporter
   */
  constructor (exporter, prioritySampler, config, nativeSpans, otlpStatsExporter) {
    super(exporter, prioritySampler, config, otlpStatsExporter)
    this._nativeSpans = nativeSpans
  }

  /**
   * Apply normal JS sampling and mirror the resulting trace decision to native storage.
   * @param {object} span Span being sampled
   */
  sample (span) {
    super.sample(span)
    const context = span.context()
    if (context._nativeSpanId === undefined || typeof context._sampling.priority !== 'number') return
    this.#syncSampling(context, context._nativeSpanId)
  }

  /**
   * Process a finished native span and export complete or threshold-sized chunks.
   * @param {object} span Finished span
   */
  process (span) {
    const spanContext = span.context()
    const trace = spanContext._trace
    const { flushMinSpans, DD_TRACE_ENABLED } = this._config
    const { started, finished } = trace

    if (trace.record === false || DD_TRACE_ENABLED === false) {
      const discarded = this.#discardSpans(started)
      this._erase(trace, [])
      if (!discarded) this._exporter._resetNativeStateWhenIdle?.()
      return
    }

    const allStartedFinished = started.length === finished.length
    if (allStartedFinished || finished.length >= flushMinSpans) {
      const active = []
      const spansToExport = allStartedFinished ? started : []
      this.sample(span)
      this._gitMetadataTagger.tagGitMetadata(spanContext)
      this.#syncTraceTags(spanContext, spanContext._nativeSpanId)

      let isFirstSpanInChunk = true
      const stampApmDisabled = this._config.apmTracingEnabled === false
      const otelSemantics = this._config.DD_TRACE_OTEL_SEMANTICS_ENABLED

      for (const startedSpan of started) {
        if (startedSpan._duration === undefined) {
          active.push(startedSpan)
          continue
        }
        if (!allStartedFinished) spansToExport.push(startedSpan)

        const context = startedSpan.context()
        if (stampApmDisabled) context.setTag(APM_TRACING_ENABLED_KEY, 0)

        if (trace.isRecording !== false) {
          let formattedSpan
          if (this._stats) {
            formattedSpan = spanFormat(startedSpan, isFirstSpanInChunk, this._processTags)
            this._stats.onSpanFinished(formattedSpan)
          }

          const fastSynced = formattedSpan === undefined && startedSpan._tryFastNativeFinalSync?.() === true
          if (!fastSynced) {
            formattedSpan ??= spanFormat(startedSpan, isFirstSpanInChunk, this._processTags)
            context.syncFinalTagsToNative(normalizeSpan(formattedSpan))
          }
          if (otelSemantics) context.applyOtelHttpSemantics?.()
        }
        isFirstSpanInChunk = false
      }

      if (spansToExport.length > 0 && trace.isRecording !== false) {
        const chunkRoot = this.#chunkRoot(spansToExport)
        const chunkRootContext = chunkRoot.context()
        this.#syncProcessTags(chunkRootContext, chunkRootContext._nativeSpanId)
        this._exporter.export(spansToExport)
        for (const exportedSpan of spansToExport) exportedSpan.context().markExported?.()
      }

      this._erase(trace, active)
      if (trace.isRecording === false) {
        const discarded = this.#discardSpans(spansToExport)
        if (!discarded) this._exporter._resetNativeStateWhenIdle?.()
      }
    }

    if (this._killAll) {
      for (const startedSpan of started) {
        if (!startedSpan._finished) startedSpan.finish()
      }
    }
  }

  /**
   * Mirror sampling priority and rule decision metrics to native trace storage.
   * @param {object} context Sampled span context
   * @param {Uint8Array} spanId Native span handle
   */
  #syncSampling (context, spanId) {
    this._nativeSpans.queueOp(
      OpCode.SetTraceMetricsAttr,
      spanId,
      '_sampling_priority_v1',
      ['f64', context._sampling.priority]
    )

    const trace = context._trace
    this.#syncTraceMetric(spanId, SAMPLING_RULE_DECISION, trace[SAMPLING_RULE_DECISION])
    this.#syncTraceMetric(spanId, SAMPLING_LIMIT_DECISION, trace[SAMPLING_LIMIT_DECISION])
    this.#syncTraceMetric(spanId, SAMPLING_AGENT_DECISION, trace[SAMPLING_AGENT_DECISION])
  }

  /**
   * Write a finite trace metric when present.
   * @param {Uint8Array} spanId Native span handle
   * @param {string} key Metric name
   * @param {unknown} value Candidate metric value
   */
  #syncTraceMetric (spanId, key, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    this._nativeSpans.queueOp(OpCode.SetTraceMetricsAttr, spanId, key, ['f64', value])
  }

  /**
   * Mirror propagation and origin tags to native trace storage.
   * @param {object} context Span context carrying trace state
   * @param {Uint8Array} spanId Native span handle
   */
  #syncTraceTags (context, spanId) {
    if (spanId === undefined) return
    const trace = context._trace
    for (const key of Object.keys(trace.tags)) {
      const value = trace.tags[key]
      if (typeof value === 'string') {
        this._nativeSpans.queueOp(OpCode.SetTraceMetaAttr, spanId, key, value)
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        this._nativeSpans.queueOp(OpCode.SetTraceMetricsAttr, spanId, key, ['f64', value])
      }
    }
    if (typeof trace.origin === 'string') {
      this._nativeSpans.queueOp(OpCode.SetTraceMetaAttr, spanId, ORIGIN_KEY, trace.origin)
    }
  }

  /**
   * Add process tags to the chunk root when the feature is configured.
   * @param {object} context Chunk-root context
   * @param {Uint8Array} spanId Native span handle
   */
  #syncProcessTags (context, spanId) {
    if (typeof this._processTags !== 'string' || this._processTags.length === 0) return
    if (context.hasTag(processTags.TRACING_FIELD_NAME)) return
    const value = this._processTags.length > MAX_META_VALUE_LENGTH
      ? `${this._processTags.slice(0, MAX_META_VALUE_LENGTH)}...`
      : this._processTags
    this._nativeSpans.queueOp(OpCode.SetMetaAttr, spanId, processTags.TRACING_FIELD_NAME, value)
  }

  /**
   * Select the first local root without allocating a filtered span list.
   * @param {object[]} spans Finished spans in this chunk
   * @returns {object} Chunk root
   */
  #chunkRoot (spans) {
    for (const span of spans) {
      const context = span.context()
      if (!context._parentId || context._isRemote || context._trace?.started?.[0] === span) return span
    }
    return spans[0]
  }

  /**
   * Remove filtered native spans and prevent subsequent writes to their storage.
   * @param {object[]} spans Native spans to discard
   * @returns {boolean} Whether native storage removed the spans
   */
  #discardSpans (spans) {
    if (spans.length === 0) return true
    const discarded = this._exporter._discardNativeSpans(spans)
    for (const span of spans) span.context().markExported?.()
    return discarded
  }
}

module.exports = NativeSpanProcessor
