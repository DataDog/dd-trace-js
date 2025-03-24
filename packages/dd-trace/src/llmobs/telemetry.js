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
  const autoEnabled = Number(!!config._env['llmobs.enabled'])
  const tags = {
    error: 0,
    agentless: Number(config.llmobs.agentlessEnabled),
    site: config.site,
    auto: autoEnabled
  }
  llmobsMetrics.count('product_enabled', tags).inc(value)
  llmobsMetrics.distribution('init_time', tags).track(initTimeMs)
}

module.exports = {
  recordLLMObsEnabled,
  incrementLLMObsSpanStartCount,
  incrementLLMObsSpanFinishedCount
}
