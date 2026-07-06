'use strict'

const log = require('../log')
const { LLMOBS_SUBMITTED_TAG_KEY } = require('./constants/tags')
const {
  CACHED_LLMOBS_EVENT_SYMBOL,
  LLMOBS_META_STRUCT_KEY,
  LLMObsExportMode,
  getLLMObsExportMode,
} = require('./export-mode')

/** @type {import('./writers/spans') | null} */
let writer

/**
 * Sets the writer used to rescue LLMObs events from sampled-out APM agent traces.
 *
 * @param {import('./writers/spans') | null} nextWriter
 * @returns {void}
 */
function setWriter (nextWriter) {
  writer = nextWriter
}

/**
 * Resubmits cached LLMObs events when the local APM agent path will drop the trace.
 *
 * @param {Array<import('../opentracing/span')>} spans
 * @param {import('../config/config-base')} config
 * @returns {void}
 */
function processTrace (spans, config) {
  if (!writer || getLLMObsExportMode(config) !== LLMObsExportMode.APM_AGENT) return

  const samplingPriority = spans[0]?.context()?._sampling?.priority
  if (samplingPriority === undefined || samplingPriority > 0) return

  for (const span of spans) {
    if (span._duration === undefined) continue
    if (!span.meta_struct?.[LLMOBS_META_STRUCT_KEY]) continue

    const cached = span[CACHED_LLMOBS_EVENT_SYMBOL]
    if (!cached) {
      scrubMetaStruct(span)
      continue
    }

    try {
      const enqueued = writer.append(cached.event, cached.routing)
      if (enqueued) {
        span.context().setTag(LLMOBS_SUBMITTED_TAG_KEY, '1')
      }
    } catch (error) {
      log.warn(
        'Failed to rescue LLM Observability span event from a sampled-out APM trace: %s',
        error.message
      )
    } finally {
      scrubMetaStruct(span)
    }
  }
}

/**
 * Removes the LLMObs event from APM trace metadata without disturbing other structured metadata.
 *
 * @param {import('../opentracing/span')} span
 * @returns {void}
 */
function scrubMetaStruct (span) {
  const metaStruct = span.meta_struct
  if (!metaStruct) return

  delete metaStruct[LLMOBS_META_STRUCT_KEY]
  if (Object.keys(metaStruct).length === 0) {
    span.meta_struct = undefined
  }
}

module.exports = {
  processTrace,
  setWriter,
}
