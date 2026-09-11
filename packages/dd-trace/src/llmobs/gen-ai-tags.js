'use strict'

const {
  CACHE_READ_INPUT_TOKENS_METRIC_KEY,
  CACHE_WRITE_INPUT_TOKENS_METRIC_KEY,
  DEFAULT_MODEL,
  GEN_AI_APPLICATION_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS_METRIC_KEY,
  GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS_METRIC_KEY,
  GEN_AI_USAGE_INPUT_TOKENS_METRIC_KEY,
  GEN_AI_USAGE_OUTPUT_TOKENS_METRIC_KEY,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS_METRIC_KEY,
  GEN_AI_USAGE_TOTAL_TOKENS_METRIC_KEY,
  INPUT_TOKENS_METRIC_KEY,
  METRIC_KEY_ALIASES,
  OUTPUT_TOKENS_METRIC_KEY,
  REASONING_OUTPUT_TOKENS_METRIC_KEY,
  TOTAL_TOKENS_METRIC_KEY,
} = require('./constants/tags')

/** @type {Set<string | undefined>} */
const MODEL_BACKED_SPAN_KINDS = new Set(['llm', 'embedding'])

const GEN_AI_USAGE_METRIC_KEYS = {
  [INPUT_TOKENS_METRIC_KEY]: GEN_AI_USAGE_INPUT_TOKENS_METRIC_KEY,
  [OUTPUT_TOKENS_METRIC_KEY]: GEN_AI_USAGE_OUTPUT_TOKENS_METRIC_KEY,
  [TOTAL_TOKENS_METRIC_KEY]: GEN_AI_USAGE_TOTAL_TOKENS_METRIC_KEY,
  [CACHE_READ_INPUT_TOKENS_METRIC_KEY]: GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS_METRIC_KEY,
  [CACHE_WRITE_INPUT_TOKENS_METRIC_KEY]: GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS_METRIC_KEY,
  [REASONING_OUTPUT_TOKENS_METRIC_KEY]: GEN_AI_USAGE_REASONING_OUTPUT_TOKENS_METRIC_KEY,
}

/**
 * @typedef {object} GenAiApmTags
 * @property {string} [spanKind] LLMObs span kind
 * @property {string} [modelName]
 * @property {string} [modelProvider]
 * @property {string} [mlApp]
 * @property {string} [sessionId]
 * @property {Record<string, unknown>} [metrics] LLMObs metrics, in either spelling
 */

/**
 * Writes the scalar `gen_ai.*` attributes onto the APM span, so model, provider, application,
 * conversation and token usage are searchable in APM. Message bodies stay off the APM span.
 *
 * @param {import('../opentracing/span')} span
 * @param {GenAiApmTags} tags
 * @returns {void}
 */
function setGenAiApmTags (span, tags) {
  // mirrors the LLMObs span event: a model-backed span always reports a model and provider
  updateGenAiApmTags(span, MODEL_BACKED_SPAN_KINDS.has(tags.spanKind)
    ? { ...tags, modelName: tags.modelName || DEFAULT_MODEL, modelProvider: tags.modelProvider || DEFAULT_MODEL }
    : tags)
}

/**
 * Writes only the `gen_ai.*` attributes present in `tags`, for values an integration resolves
 * after the span started. Absent fields keep whatever the span already carries.
 *
 * @param {import('../opentracing/span')} span
 * @param {GenAiApmTags} tags
 * @returns {void}
 */
function updateGenAiApmTags (span, { spanKind, modelName, modelProvider, mlApp, sessionId, metrics }) {
  const spanContext = span.context()

  if (spanKind) spanContext.setTag(GEN_AI_OPERATION_NAME, spanKind)
  if (modelName) spanContext.setTag(GEN_AI_REQUEST_MODEL, modelName)
  if (modelProvider) spanContext.setTag(GEN_AI_PROVIDER_NAME, modelProvider.toLowerCase())
  if (mlApp) spanContext.setTag(GEN_AI_APPLICATION_NAME, mlApp)
  if (sessionId) spanContext.setTag(GEN_AI_CONVERSATION_ID, sessionId)
  if (metrics) setGenAiApmUsageMetrics(span, spanKind, metrics)
}

/**
 * Writes the `gen_ai.usage.*` metrics onto the APM span. Accepts both the LLMObs metric keys and
 * the camelCase spellings integrations extract before the tagger normalizes them.
 *
 * @param {import('../opentracing/span')} span
 * @param {string | undefined} spanKind LLMObs span kind
 * @param {Record<string, unknown>} metrics
 * @returns {void}
 */
function setGenAiApmUsageMetrics (span, spanKind, metrics) {
  // Other kinds carry unrelated metrics that would be misleading under a `gen_ai.usage.*` key.
  if (!MODEL_BACKED_SPAN_KINDS.has(spanKind)) return

  const spanContext = span.context()
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== 'number') continue

    const genAiKey = GEN_AI_USAGE_METRIC_KEYS[METRIC_KEY_ALIASES[key] ?? key]
    if (genAiKey) spanContext.setTag(genAiKey, value)
  }
}

module.exports = {
  MODEL_BACKED_SPAN_KINDS,
  setGenAiApmTags,
  setGenAiApmUsageMetrics,
  updateGenAiApmTags,
}
