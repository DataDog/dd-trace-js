'use strict'

const {
  SPAN_KIND,
  MODEL_PROVIDER,
  PARENT_ID_KEY,
  SESSION_ID,
  INTEGRATION
} = require('./constants/tags')

const telemetryMetrics = require('../telemetry/metrics')

const LLMObsTagger = require('./tagger')

const llmobsMetrics = telemetryMetrics.manager.namespace('mlobs')

function incrementLLMObsSpanStartCount (tags, value = 1) {
  llmobsMetrics.count('span.start', tags).inc(value)
}

function incrementLLMObsSpanFinishedCount (span, value = 1) {
  const mlObsTags = LLMObsTagger.tagMap.get(span)

  const isRootSpan = mlObsTags[PARENT_ID_KEY] !== ROOT_PARENT_ID
  const hasSessionId = mlObsTags[SESSION_ID] !== null
  const integration = mlObsTags[INTEGRATION]
  const autoInstrumented = integration !== null
  const spanKind = mlObsTags[SPAN_KIND]
  const modelProvider = mlObsTags[MODEL_PROVIDER]

  const tags = {
    autoinstrumented: autoInstrumented,
    has_session_id: hasSessionId,
    is_root_span: isRootSpan,
    span_kind: spanKind,
    integration: integration || "N/A",
  }
  if (modelProvider) {
    tags.model_provider = modelProvider
  }

  llmobsMetrics.count('span.finished', tags).inc(value)
}

module.exports = {
  incrementLLMObsSpanStartCount,
  incrementLLMObsSpanFinishedCount
}
