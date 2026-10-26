'use strict'

const LLMObsPlugin = require('../base')

const TYPESAFE_MODEL_PROVIDER = 'typesafe'
const OPENROUTER_MODEL_PROVIDER = 'openrouter'

class TypeSafeLLMObsPlugin extends LLMObsPlugin {
  static integration = 'typesafe' // used for llmobs telemetry
  static id = 'typesafe'
  static prefix = 'tracing:apm:typesafe:request'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'llm',
      modelName: getModelName(ctx),
      modelProvider: getModelProvider(ctx.baseURL),
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

    const { result } = ctx
    const inputMessages = [{ role: 'user', content: serializeRequest(ctx) ?? '' }]

    if (ctx.error || result === undefined) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    const output = typeof result === 'string' ? result : JSON.stringify(result)
    this._tagger.tagLLMIO(span, inputMessages, [{ role: 'assistant', content: output }])

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
  return ctx.request?.model ?? ctx.defaultModel
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
  if (inputTokens != null || outputTokens != null) metrics.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0)
  return metrics
}

/**
 * The body the SDK sent, or, when it sent none (e.g. a request that failed validation), the request as passed.
 *
 * @param {object} ctx
 */
function serializeRequest (ctx) {
  const { request, requestBody, defaultModel } = ctx
  try {
    if (requestBody !== undefined) return JSON.stringify(requestBody)
    if (request && typeof request === 'object') {
      return JSON.stringify({ ...request, model: request.model ?? defaultModel })
    }
  } catch {}
}

module.exports = TypeSafeLLMObsPlugin
