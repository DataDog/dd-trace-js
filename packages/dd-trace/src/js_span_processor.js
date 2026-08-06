'use strict'

// JS span processor for the CI Visibility pipeline.
//
// Test Optimization / CI Visibility has its own event model and intake and
// cannot ride the native (WASM trace-chunk) pipeline, so when the tracer runs
// with `config.isCiVisibility` it uses plain JS spans, this processor (which
// formats spans with `span_format` and hands them to a CI-vis exporter), and an
// exporter selected by `getExporter`. Regular APM tracing uses the native
// pipeline (`src/span_processor.js` + `NativeExporter`). This is the pre-native
// span processor, kept for the CI-vis path and pared down (no APM trace-stats,
// which CI Visibility does not use).

const eraseTrace = require('./span-processor-state')
const spanFormat = require('./span_format')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const processTags = require('./process-tags')
const { applyHttpOtelSemantics } = require('./plugins/util/http-otel-semantics')
const { APM_TRACING_ENABLED_KEY } = require('./constants')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

class JsSpanProcessor {
  constructor (exporter, prioritySampler, config, otlpStatsExporter) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
    this._config = config
    this._killAll = false

    this._spanSampler = new SpanSampler(config.sampler)
    this._gitMetadataTagger = new GitMetadataTagger(config)

    this._processTags = config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED
      ? processTags.serialized
      : false

    if (!config.isCiVisibility && (config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED || otlpStatsExporter)) {
      const { SpanStatsProcessor } = require('./span_stats')
      this._stats = new SpanStatsProcessor(config, otlpStatsExporter)
    }
  }

  sample (span) {
    const spanContext = span.context()
    this._prioritySampler.sample(spanContext)
    this._spanSampler.sample(spanContext)
  }

  process (span) {
    const spanContext = span.context()
    const active = []
    const formatted = []
    const trace = spanContext._trace
    const { flushMinSpans, DD_TRACE_ENABLED } = this._config
    const { started, finished } = trace

    if (trace.record === false) return
    if (DD_TRACE_ENABLED === false) {
      eraseTrace(trace, active, this._config.DD_TRACE_EXPERIMENTAL_STATE_TRACKING, startedSpans, finishedSpans)
      return
    }
    if (started.length === finished.length || finished.length >= flushMinSpans) {
      this.sample(span)
      this._gitMetadataTagger.tagGitMetadata(spanContext)

      let isFirstSpanInChunk = true

      for (const span of started) {
        if (span._duration === undefined) {
          active.push(span)
        } else {
          if (isFirstSpanInChunk && this._config.apmTracingEnabled === false) {
            span.context().setTag(APM_TRACING_ENABLED_KEY, 0)
          }
          const formattedSpan = spanFormat(span, isFirstSpanInChunk, this._processTags)
          if (this._stats) this._stats.onSpanFinished(formattedSpan)
          isFirstSpanInChunk = false
          if (this._config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
            applyHttpOtelSemantics(formattedSpan)
          }
          formatted.push(formattedSpan)
        }
      }

      if (formatted.length !== 0 && trace.isRecording !== false) {
        this._exporter.export(formatted)
      }

      eraseTrace(trace, active, this._config.DD_TRACE_EXPERIMENTAL_STATE_TRACKING, startedSpans, finishedSpans)
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
}

module.exports = JsSpanProcessor
