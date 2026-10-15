'use strict'

const LLMObsPlugin = require('../base')

const TYPESAFE_MODEL_PROVIDER = 'typesafe'
const OPENROUTER_MODEL_PROVIDER = 'openrouter'

class TypeSafeLLMObsPlugin extends LLMObsPlugin {
  static integration = 'typesafe' // used for llmobs telemetry
  static id = 'typesafe'
  static prefix = 'tracing:apm:typesafe:request'

  start (ctx) {
    // Captured at call time, when the SDK serializes the request: the caller may reuse and change the object
    // before the response arrives.
    if (this._llmobsEnabledFor(ctx)) {
      ctx.llmobsRequest = {
        state: toWireValue(ctx.request?.state),
        questions: toWireValue(ctx.request?.questions),
      }
    }
    super.start(ctx)
  }

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

    const { llmobsRequest, result } = ctx
    const inputMessages = [{ role: 'user', content: stringify(llmobsRequest?.state) }]

    if (llmobsRequest?.questions) this._tagger.tagMetadata(span, { questions: llmobsRequest.questions })

    if (ctx.error || !result) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    this._tagger.tagLLMIO(span, inputMessages, [{ role: 'assistant', content: stringify(result.answers) }])

    const metrics = extractMetrics(result)
    if (metrics) this._tagger.tagMetrics(span, metrics)

    if (result.model) this._tagger.tagModelName(span, result.model)
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

  const metrics = {}
  if (usage.input_tokens != null) metrics.inputTokens = usage.input_tokens
  if (usage.output_tokens != null) metrics.outputTokens = usage.output_tokens
  if (usage.input_tokens != null || usage.output_tokens != null) {
    metrics.totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
  }
  return metrics
}

/**
 * Converts a request value to the JSON the SDK sends. Image assets serialize to their `<image:…>` reference and
 * text with assets to its text through their `toJSON`, which the span processor's object copy would otherwise skip,
 * copying image bytes onto the span one index at a time.
 *
 * @param {unknown} value
 */
function toWireValue (value) {
  if (value === undefined) return
  try {
    // eslint-disable-next-line unicorn/prefer-structured-clone -- structuredClone skips toJSON and copies the bytes
    return JSON.parse(JSON.stringify(value))
  } catch {}
}

/**
 * @param {unknown} value
 */
function stringify (value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

module.exports = TypeSafeLLMObsPlugin
