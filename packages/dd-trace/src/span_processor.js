'use strict'

const log = require('./log')
const SpanSampler = require('./span_sampler')
const GitMetadataTagger = require('./git_metadata_tagger')
const native = require('./native')
const {
  SAMPLING_MECHANISM_MANUAL,
  SAMPLING_RULE_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_AGENT_DECISION,
  DECISION_MAKER_KEY,
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

    this._spanSampler = new SpanSampler(config.sampler)
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
   * @param {object} spanContext - The span context
   * @param {number} slotIndex - The native slot index
   * @private
   */
  _syncSamplingToNative (spanContext, slotIndex) {
    // Sync priority as trace metric
    this._nativeSpans.queueOp(
      native.OpCode.SetTraceMetricsAttr,
      slotIndex,
      '_sampling_priority_v1',
      ['f64', spanContext._sampling.priority]
    )

    // Sync mechanism as trace meta if set
    if (spanContext._sampling.mechanism !== undefined) {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetaAttr,
        slotIndex,
        '_dd.p.dm',
        `-${spanContext._sampling.mechanism}`
      )
    }

    // Forward sampling-decision metrics written by priority_sampler.js
    // Previously span_format.js copied these from _trace[KEY] onto root spans.
    const traceObj = spanContext._trace
    if (typeof traceObj[SAMPLING_RULE_DECISION] === 'number') {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetricsAttr,
        slotIndex,
        SAMPLING_RULE_DECISION,
        ['f64', traceObj[SAMPLING_RULE_DECISION]]
      )
    }
    if (typeof traceObj[SAMPLING_LIMIT_DECISION] === 'number') {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetricsAttr,
        slotIndex,
        SAMPLING_LIMIT_DECISION,
        ['f64', traceObj[SAMPLING_LIMIT_DECISION]]
      )
    }
    if (typeof traceObj[SAMPLING_AGENT_DECISION] === 'number') {
      this._nativeSpans.queueOp(
        native.OpCode.SetTraceMetricsAttr,
        slotIndex,
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

    // AUTO_KEEP = 0, so priority >= 0 means keep
    if (priority >= 0) {
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

      // Pass raw spans to the native exporter; the WASM pipeline serializes
      // them. When native stats are enabled the concentrator handles stats
      // aggregation during flush_chunk.
      const finishedSpansToExport = []

      for (const span of started) {
        if (span._duration === undefined) {
          active.push(span)
        } else {
          finishedSpansToExport.push(span)
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
