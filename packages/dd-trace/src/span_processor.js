'use strict'

const log = require('./log')
const spanFormat = require('./span_format')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const processTags = require('./process-tags')
const { getValueFromEnvSources } = require('./config/helper')
const {
  SAMPLING_MECHANISM_MANUAL,
  SAMPLING_MECHANISM_DEFAULT,
  DECISION_MAKER_KEY
} = require('./constants')

// Hoisted out of the per-trace _erase hot path: this env var is process-static
// and the JS msgpack encoder used to read it once at construction. Keeping it
// in _erase (called every flushed trace) was burning ~1.4% of CPU on the express
// hello-world benchmark.
const STATE_TRACKING_ENABLED = getValueFromEnvSources('DD_TRACE_EXPERIMENTAL_STATE_TRACKING') === 'true'

// Hoisted out of the per-span _syncSamplingToNative hot path: every inline
// require() goes through the import-in-the-middle Hook.Module.require
// interceptor, which does env-var checks (DD_TRACE_DISABLED_INSTRUMENTATIONS
// etc.) on every call. Profile attributed ~1.5% of CPU to this single line.
// ./native exports `available`, so consumers must still gate on that.
const { OpCode: NATIVE_OP_CODE } = require('./native')

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

    // In native mode with stats, the WASM concentrator handles stats aggregation
    // (spans are fed to it during flush_chunk), so we skip the JS stats processor.
    this._isNativeStats = this._isNativeMode && config.stats?.enabled

    // TODO: This should already have been calculated in `config.js`.
    if (config.stats?.enabled && !config.appsec?.standalone?.enabled && !this._isNativeStats) {
      const { SpanStatsProcessor } = require('./span_stats')
      this._stats = new SpanStatsProcessor(config)
    }

    this._spanSampler = new SpanSampler(config.sampler)
    this._gitMetadataTagger = new GitMetadataTagger(config)

    this._processTags = config.propagateProcessTags?.enabled
      ? processTags.serialized
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
      spanContext.getTags(),
      spanContext
    )

    if (this._prioritySampler.validate(manualPriority)) {
      // Manual override - set in JS context
      spanContext._sampling.priority = manualPriority
      spanContext._sampling.mechanism = SAMPLING_MECHANISM_MANUAL

      // Sync manual decision to native storage
      const slotIndex = spanContext._slotIndex
      if (slotIndex !== undefined) {
        this._syncSamplingToNative(spanContext, slotIndex)
      }
    } else {
      // Use JS-side sampling
      this._prioritySampler.sample(spanContext)

      // Sync sampling decision to native storage if span is in native storage
      if (spanContext._slotIndex !== undefined) {
        this._syncSamplingToNative(spanContext, spanContext._slotIndex)
      }
    }

    // Add decision maker tag
    this._addDecisionMaker(root)
  }

  /**
   * Sync sampling decision from JS to native storage.
   *
   * @param {Object} spanContext - The span context
   * @param {number} slotIndex - The native slot index
   * @private
   */
  _syncSamplingToNative (spanContext, slotIndex) {
    // Sync priority as trace metric
    this._nativeSpans.queueOp(
      NATIVE_OP_CODE.SetTraceMetricsAttr,
      slotIndex,
      '_sampling_priority_v1',
      ['f64', spanContext._sampling.priority]
    )

    // Sync mechanism as trace meta if set
    if (spanContext._sampling.mechanism !== undefined) {
      this._nativeSpans.queueOp(
        NATIVE_OP_CODE.SetTraceMetaAttr,
        slotIndex,
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
        // Native mode: pass raw spans to native exporter.
        // When native stats are enabled, the WASM concentrator handles stats
        // aggregation during flush_chunk (no spanFormat call needed).
        // When native stats are NOT enabled but JS stats are, we still need
        // spanFormat for the JS stats processor.
        const finishedSpans = []

        let isFirstSpanInChunk = true

        for (const span of started) {
          if (span._duration === undefined) {
            active.push(span)
          } else {
            finishedSpans.push(span)
            // JS stats fallback (only when native stats are disabled)
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
    if (STATE_TRACKING_ENABLED) {
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
      // Skip clearing tags for native spans since:
      // 1. Tags are already synced to native storage
      // 2. Keeps tags accessible for debugging/testing after export
      // 3. Memory will be freed when span is garbage collected anyway
      if (!this._isNativeMode) {
        span.context().clearTags()
      }
    }

    trace.started = active
    trace.finished = []
  }
}

module.exports = SpanProcessor
