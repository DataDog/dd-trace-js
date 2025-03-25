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
  if (!Array.isArray(tags)) return null
  const integrationTag = tags.find(tag => tag.startsWith('integration:'))
  if (!integrationTag) return null
  return integrationTag.split(':')[1] || null
}

function extractTagsFromSpanEvent (event) {
  const spanKind = event.meta?.['span.kind'] || ''
  const integration = extractIntegrationFromTags(event.tags)
  const error = event.status === 'error'
  const autoinstrumented = integration != null

  return {
    span_kind: spanKind,
    autoinstrumented: Number(autoinstrumented),
    error: error ? 1 : 0,
    integration: integration || 'N/A'
  }
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

function recordLLMObsEnabled (startTime, config, value = 1) {
  const initTimeMs = performance.now() - startTime
  // There isn't an easy way to determine if a user automatically enabled LLMObs via
  // in-code or command line setup. We'll use the presence of DD_LLMOBS_ENABLED env var
  // as a rough heuristic, but note that this isn't perfect since
  // a user may have env vars but enable manually in code.
  const autoEnabled = Number(!!config._env?.['llmobs.enabled'])
  const tags = {
    error: 0,
    agentless: Number(config.llmobs.agentlessEnabled),
    site: config.site,
    auto: autoEnabled
  }
  llmobsMetrics.count('product_enabled', tags).inc(value)
  llmobsMetrics.distribution('init_time', tags).track(initTimeMs)
}

function recordLLMObsRawSpanSize (event, rawEventSize) {
  const tags = extractTagsFromSpanEvent(event)
  llmobsMetrics.distribution('span.raw_size', tags).track(rawEventSize)
}

function recordLLMObsSpanSize (event, eventSize, shouldTruncate) {
  const tags = extractTagsFromSpanEvent(event)
  tags.truncated = Number(shouldTruncate)
  llmobsMetrics.distribution('span.size', tags).track(eventSize)
}

module.exports = {
  recordLLMObsEnabled,
  incrementLLMObsSpanStartCount,
  incrementLLMObsSpanFinishedCount,
  recordLLMObsRawSpanSize,
  recordLLMObsSpanSize
}
