'use strict'

const log = require('./log')
const spanFormat = require('./span_format')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const llmobsSamplingFallbackProcessor = require('./llmobs/sampling-fallback-processor')
const processTags = require('./process-tags')
const { applyHttpOtelSemantics } = require('./plugins/util/http-otel-semantics')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

class SpanProcessor {
  constructor (exporter, prioritySampler, config, otlpStatsExporter) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
    this._config = config
    this._killAll = false

    if (config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED && !config.appsec?.standalone?.enabled) {
      const { SpanStatsProcessor } = require('./span_stats')
      this._stats = new SpanStatsProcessor(config, otlpStatsExporter)
    }

    this._spanSampler = new SpanSampler(config.sampler)
    this._gitMetadataTagger = new GitMetadataTagger(config)

    this._processTags = config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED
      ? processTags.serialized
      : false
  }

  sample (span) {
    const spanContext = span.context()
    this._prioritySampler.sample(spanContext)
    this._spanSampler.sample(spanContext)
  }

  /**
   * @param {object} exporter
   */
  setExporter (exporter) {
    this._exporter = exporter
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
      this._erase(trace, active)
      return
    }
    if (started.length === finished.length || finished.length >= flushMinSpans) {
      this.sample(span)
      llmobsSamplingFallbackProcessor.processTrace(started, this._config)
      this._gitMetadataTagger.tagGitMetadata(spanContext)

      let isFirstSpanInChunk = true

      for (const span of started) {
        if (span._duration === undefined) {
          active.push(span)
        } else {
          const formattedSpan = spanFormat(span, isFirstSpanInChunk, this._processTags)
          isFirstSpanInChunk = false
          // Span stats read Datadog HTTP tag names from the formatted span, so
          // record them before the OTel rename — an export-only transform.
          this._stats?.onSpanFinished(formattedSpan)
          if (this._config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
            applyHttpOtelSemantics(formattedSpan)
          }
          formatted.push(formattedSpan)
        }
      }

      if (formatted.length !== 0 && trace.isRecording !== false) {
        this._exporter.export(formatted)
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
