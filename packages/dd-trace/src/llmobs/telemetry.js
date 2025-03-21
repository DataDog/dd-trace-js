'use strict'

const {
  SPAN_KIND,
  MODEL_PROVIDER,
  PARENT_ID_KEY,
  SESSION_ID,
  ROOT_PARENT_ID,
  INTEGRATION,
  DECORATOR
} = require('./constants/tags')

const ERROR_TYPE = require('../constants')

const telemetryMetrics = require('../telemetry/metrics')

const LLMObsTagger = require('./tagger')

const llmobsMetrics = telemetryMetrics.manager.namespace('mlobs')

function extractIntegrationFromTags (tags) {
  const integrationTag = tags.find(tag => tag.startsWith('integration:'))
  if (!integrationTag) return null
  return integrationTag.split(':')[1] || null
}

function incrementLLMObsSpanStartCount (tags, value = 1) {
  llmobsMetrics.count('span.start', tags).inc(value)
}

function incrementLLMObsSpanFinishedCount (span, value = 1) {
  const mlObsTags = LLMObsTagger.tagMap.get(span)
  const spanTags = span.context()._tags

  const isRootSpan = mlObsTags[PARENT_ID_KEY] === ROOT_PARENT_ID
  const hasSessionId = mlObsTags[SESSION_ID] != null
  const integration = mlObsTags[INTEGRATION]
  const autoInstrumented = integration != null
  const decorator = !!mlObsTags[DECORATOR]
  const spanKind = mlObsTags[SPAN_KIND]
  const modelProvider = mlObsTags[MODEL_PROVIDER]
  const error = spanTags.error || spanTags[ERROR_TYPE]

  const tags = {
    autoinstrumented: Number(autoInstrumented),
    has_session_id: Number(hasSessionId),
    is_root_span: Number(isRootSpan),
    span_kind: spanKind,
    integration: integration || 'N/A',
    error: error ? 1 : 0
  }
  if (!autoInstrumented) {
    tags.decorator = Number(decorator)
  }
  if (modelProvider) {
    tags.model_provider = modelProvider
  }

  llmobsMetrics.count('span.finished', tags).inc(value)
}

function submitLLMObsRawSpanSize (event, rawEventSize) {
  const spanKind = event.meta?.spanKind || ''
  const integration = extractIntegrationFromTags(event.tags)
  const error = event.status === 'error'
  const autoinstrumented = integration != null

  const tags = {
    span_kind: spanKind,
    autoinstrumented: Number(autoinstrumented),
    error: error ? 1 : 0,
    integration: integration || 'N/A'
  }

  console.log('SUBMITTING RAW EVENT SIZE METRIC')
  llmobsMetrics.distribution('span.raw_size', tags).track({ rawEventSize })
}

module.exports = {
  incrementLLMObsSpanStartCount,
  incrementLLMObsSpanFinishedCount,
  submitLLMObsRawSpanSize
}
