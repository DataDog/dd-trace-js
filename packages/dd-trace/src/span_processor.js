'use strict'

const log = require('./log')
const spanFormat = require('./span_format')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const { getEnvironmentVariable } = require('./config-helper')
const getProcessTags = require('./process-tags')
const {
  SAMPLING_MECHANISM_MANUAL,
  DECISION_MAKER_KEY
} = require('./constants')

const startedSpans = new WeakSet()
const finishedSpans = new WeakSet()

class SpanProcessor {
  constructor (exporter, prioritySampler, config, nativeSpans = null) {
    this._exporter = exporter
    this._prioritySampler = prioritySampler
    this._config = config
    this._killAll = false
    this._nativeSpans = nativeSpans

    // Check if we're in native spans mode
    // Native mode is enabled when experimental.nativeSpans.enabled is set and the exporter is NativeExporter
    this._isNativeMode = config.experimental?.nativeSpans?.enabled === true && nativeSpans !== null

    // TODO: This should already have been calculated in `config.js`.
    if (config.stats?.enabled && !config.appsec?.standalone?.enabled) {
      const { SpanStatsProcessor } = require('./span_stats')
      this._stats = new SpanStatsProcessor(config)
    }

    this._spanSampler = new SpanSampler(config.sampler)
    this._gitMetadataTagger = new GitMetadataTagger(config)

    this._processTags = config.propagateProcessTags?.enabled
      ? getProcessTags().serialized
      : false
  }

  sample (span) {
    const spanContext = span.context()

    if (this._isNativeMode) {
      this._sampleNative(span, spanContext)
    } else {
      this._prioritySampler.sample(spanContext)
    }

    // Single span sampling always runs in JS
    this._spanSampler.sample(spanContext)
  }

  /**
   * Perform sampling in native mode.
   *
   * Manual overrides (USER_KEEP, USER_REJECT) are checked first in JS.
   * If no manual override, native sampling is used for automatic decisions.
   *
   * @param {Object} span - The span to sample
   * @param {Object} spanContext - The span's context
   * @private
   */
  _sampleNative (span, spanContext) {
    const root = spanContext._trace.started[0]

    // Already sampled - return early
    if (spanContext._sampling.priority !== undefined) return
    if (!root) return // noop span

    // Check for manual override tags first (stays in JS)
    const manualPriority = this._prioritySampler._getPriorityFromTags(
      spanContext._tags,
      spanContext
    )

    if (this._prioritySampler.validate(manualPriority)) {
      // Manual override - set in JS context
      spanContext._sampling.priority = manualPriority
      spanContext._sampling.mechanism = SAMPLING_MECHANISM_MANUAL

      // Sync manual decision to native storage
      const nativeSpanId = spanContext._nativeSpanId
      if (nativeSpanId !== undefined) {
        this._syncSamplingToNative(spanContext, nativeSpanId)
      }
    } else {
      // No manual override - use native sampling
      const nativeSpanId = spanContext._nativeSpanId ?? spanContext._spanId.toBigInt()
      const priority = this._nativeSpans.sample(nativeSpanId)

      // Set result in JS context for propagation
      spanContext._sampling.priority = priority
      // Native sampling mechanism will be determined by native side
      // We don't set mechanism here as native handles it
    }

    // Add decision maker tag
    this._addDecisionMaker(root)
  }

  /**
   * Sync sampling decision from JS to native storage.
   *
   * @param {Object} spanContext - The span context
   * @param {bigint} nativeSpanId - The native span ID
   * @private
   */
  _syncSamplingToNative (spanContext, nativeSpanId) {
    const { OpCode } = require('./native')

    // Sync priority as trace metric
    this._nativeSpans.queueOp(
      OpCode.SetTraceMetricsAttr,
      nativeSpanId,
      '_sampling_priority_v1',
      ['f64', spanContext._sampling.priority]
    )

    // Sync mechanism as trace meta if set
    if (spanContext._sampling.mechanism !== undefined) {
      this._nativeSpans.queueOp(
        OpCode.SetTraceMetaAttr,
        nativeSpanId,
        '_dd.p.dm',
        `-${spanContext._sampling.mechanism}`
      )
    }
  }

  /**
   * Add decision maker trace tag when priority is keep.
   *
   * @param {Object} span - The root span
   * @private
   */
  _addDecisionMaker (span) {
    const context = span.context()
    const trace = context._trace
    const priority = context._sampling.priority
    const mechanism = context._sampling.mechanism

    // AUTO_KEEP = 0, so priority >= 0 means keep
    if (priority >= 0) {
      if (!trace.tags[DECISION_MAKER_KEY] && mechanism !== undefined) {
        trace.tags[DECISION_MAKER_KEY] = `-${mechanism}`
      }
    } else {
      delete trace.tags[DECISION_MAKER_KEY]
    }
  }

  process (span) {
    const spanContext = span.context()
    const active = []
    const trace = spanContext._trace
    const { flushMinSpans, tracing } = this._config
    const { started, finished } = trace

    if (trace.record === false) return
    if (tracing === false) {
      this._erase(trace, active)
      return
    }
    if (started.length === finished.length || finished.length >= flushMinSpans) {
      this.sample(span)
      this._gitMetadataTagger.tagGitMetadata(spanContext)

      if (this._isNativeMode) {
        // Native mode: pass raw spans to native exporter
        // Native side handles serialization
        const finishedSpans = []

        let isFirstSpanInChunk = true

        for (const span of started) {
          if (span._duration === undefined) {
            active.push(span)
          } else {
            finishedSpans.push(span)
            // Still collect stats if enabled (requires formatted span)
            if (this._stats) {
              const formattedSpan = spanFormat(span, isFirstSpanInChunk, this._processTags)
              isFirstSpanInChunk = false
              this._stats.onSpanFinished(formattedSpan)
            }
          }
        }

        if (finishedSpans.length !== 0 && trace.isRecording !== false) {
          this._exporter.export(finishedSpans)
        }
      } else {
        // Standard mode: format spans in JS before export
        const formatted = []
        let isFirstSpanInChunk = true

        for (const span of started) {
          if (span._duration === undefined) {
            active.push(span)
          } else {
            const formattedSpan = spanFormat(span, isFirstSpanInChunk, this._processTags)
            isFirstSpanInChunk = false
            this._stats?.onSpanFinished(formattedSpan)
            formatted.push(formattedSpan)
          }
        }

        if (formatted.length !== 0 && trace.isRecording !== false) {
          this._exporter.export(formatted)
        }
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
    if (getEnvironmentVariable('DD_TRACE_EXPERIMENTAL_STATE_TRACKING') === 'true') {
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
}

module.exports = SpanProcessor
