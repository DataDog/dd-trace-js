'use strict'

const LLMObsPlugin = require('../base')

const TYPESAFE_MODEL_PROVIDER = 'typesafe'
const OPENROUTER_MODEL_PROVIDER = 'openrouter'
const DECISION_PROVIDER_TAG = 'decision_provider'
const DECISION_PROVIDER = 'typesafe'

class TypeSafeLLMObsPlugin extends LLMObsPlugin {
  static integration = 'typesafe' // used for llmobs telemetry
  static id = 'typesafe'
  static prefix = 'tracing:orchestrion:@typesafe-ai/sdk:TypeSafeClient_systemOne'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'llm',
      modelName: getModelName(ctx),
      modelProvider: getModelProvider(ctx.self?.baseURL),
      name: 'typesafe.request',
    }
  }

  /**
   * @override
   */
  getGenAiApmEndTags (ctx) {
    return { modelName: ctx.result?.model, metrics: extractMetrics(ctx.result) }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    this._tagger.tagSpanTags(span, { [DECISION_PROVIDER_TAG]: DECISION_PROVIDER })

    const { result, responseText } = ctx
    const inputMessages = [{ role: 'user', content: serializeRequest(ctx) ?? '' }]

    if (ctx.error || responseText === undefined) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    this._tagger.tagLLMIO(span, inputMessages, [{ role: 'assistant', content: responseText }])

    const metrics = extractMetrics(result)
    if (metrics) this._tagger.tagMetrics(span, metrics)

    if (result?.model) this._tagger.tagModelName(span, result.model)
  }
}

/**
 * @param {object} ctx
 * @returns {string|undefined}
 */
function getModelName (ctx) {
  return ctx.arguments?.[0]?.model ?? ctx.self?.defaultModel
}

/**
 * The SDK can be pointed at OpenRouter, which serves the same System One API.
 *
 * @param {string} [baseURL]
 */
function getModelProvider (baseURL = '') {
  return baseURL.toLowerCase().includes(OPENROUTER_MODEL_PROVIDER) ? OPENROUTER_MODEL_PROVIDER : TYPESAFE_MODEL_PROVIDER
}

/**
 * @param {object} [result]
 * @returns {Record<string, number>|undefined}
 */
function extractMetrics (result) {
  const usage = result?.usage
  if (!usage) return

  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage
  const metrics = {}
  if (inputTokens != null) metrics.inputTokens = inputTokens
  if (outputTokens != null) metrics.outputTokens = outputTokens
  // A total is only known when both counts are
  if (inputTokens != null && outputTokens != null) metrics.totalTokens = inputTokens + outputTokens
  return metrics
}

/**
 * The request as `systemOne` received it, with the model the SDK fills in. Serialized at finish, after the SDK has
 * serialized it to send.
 *
 * @param {object} ctx
 */
function serializeRequest (ctx) {
  const { request } = ctx
  if (!request) return
  try {
    return JSON.stringify({ ...request, model: request.model ?? ctx.self?.defaultModel })
  } catch {}
}

module.exports = TypeSafeLLMObsPlugin
