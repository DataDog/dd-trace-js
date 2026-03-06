'use strict'

const log = require('./log')
const spanFormat = require('./span_format')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const processTags = require('./process-tags')
const { getValueFromEnvSources } = require('./config/helper')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

class SpanProcessor {
  #exporter
  #prioritySampler
  #config
  #killAll = false
  #stats
  #spanSampler
  #gitMetadataTagger
  #processTags

  constructor (exporter, prioritySampler, config) {
    this.#exporter = exporter
    this.#prioritySampler = prioritySampler
    this.#config = config

    // TODO: This should already have been calculated in `config.js`.
    if (config.stats?.enabled && !config.appsec?.standalone?.enabled) {
      const { SpanStatsProcessor } = require('./span_stats')
      this.#stats = new SpanStatsProcessor(config)
    }

    this.#spanSampler = new SpanSampler(config.sampler)
    this.#gitMetadataTagger = new GitMetadataTagger(config)

    this.#processTags = config.propagateProcessTags?.enabled
      ? processTags.serialized
      : false
  }

  sample (span) {
    const spanContext = span.context()
    this.#prioritySampler.sample(spanContext)
    this.#spanSampler.sample(spanContext)
  }

  process (span) {
    const spanContext = span.context()
    const active = []
    const formatted = []
    const trace = spanContext._trace
    const { flushMinSpans, tracing } = this.#config
    const { started, finished } = trace

    if (trace.record === false) return
    if (tracing === false) {
      this._erase(trace, active)
      return
    }
    if (started.length === finished.length || finished.length >= flushMinSpans) {
      this.sample(span)
      this.#gitMetadataTagger.tagGitMetadata(spanContext)

      let isFirstSpanInChunk = true

      for (const span of started) {
        if (span._duration === undefined) {
          active.push(span)
        } else {
          const formattedSpan = spanFormat(span, isFirstSpanInChunk, this.#processTags)
          isFirstSpanInChunk = false
          this.#stats?.onSpanFinished(formattedSpan)
          formatted.push(formattedSpan)
        }
      }

      if (formatted.length !== 0 && trace.isRecording !== false) {
        this.#exporter.export(formatted)
      }

      this._erase(trace, active)
    }

    if (this.#killAll) {
      for (const startedSpan of started) {
        if (!startedSpan._finished) {
          startedSpan.finish()
        }
      }
    }
  }

  killAll () {
    this.#killAll = true
  }

  _erase (trace, active) {
    if (getValueFromEnvSources('DD_TRACE_EXPERIMENTAL_STATE_TRACKING') === 'true') {
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

    for (const span of trace.finished) {
      span.context()._tags = {}
    }

    trace.started = active
    trace.finished = []
  }

  get _processTags () {
    return this.#processTags
  }
}

module.exports = SpanProcessor
