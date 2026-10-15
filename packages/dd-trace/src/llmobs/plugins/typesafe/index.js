'use strict'

const LLMObsPlugin = require('../base')

const TEXT_WITH_ASSETS = Symbol.for('@typesafe-ai/sdk/text-with-assets')
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
      const assetNames = getAssetNames(ctx.request?.assets)
      ctx.llmobsRequest = {
        state: toWireValue(ctx.request?.state, assetNames),
        questions: toWireValue(ctx.request?.questions, assetNames),
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

  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage
  const metrics = {}
  if (inputTokens != null) metrics.inputTokens = inputTokens
  if (outputTokens != null) metrics.outputTokens = outputTokens
  // The SDK reports a count it did not receive as null, so a total from one count would be misleading
  if (inputTokens != null && outputTokens != null) metrics.totalTokens = inputTokens + outputTokens
  return metrics
}

/**
 * @param {Record<string, object>} [assets] - The request's named assets
 * @returns {Map<object, string>|undefined}
 */
function getAssetNames (assets) {
  if (!assets || typeof assets !== 'object') return
  const names = new Map()
  for (const [name, asset] of Object.entries(assets)) names.set(asset, name)
  return names.size > 0 ? names : undefined
}

/**
 * Converts a request value to the JSON the SDK sends. Image assets serialize to their `<image:…>` reference and
 * text with assets to its text through their `toJSON`, which the span processor's object copy would otherwise skip,
 * copying image bytes onto the span one index at a time. Assets given names in the request's `assets` are sent
 * under those names instead, so they are replaced the same way the SDK does.
 *
 * @param {unknown} value
 * @param {Map<object, string>} [assetNames]
 */
function toWireValue (value, assetNames) {
  if (value === undefined) return
  try {
    const json = assetNames ? JSON.stringify(value, nameAssets(assetNames)) : JSON.stringify(value)
    return JSON.parse(json)
  } catch {}
}

/**
 * @param {Map<object, string>} assetNames
 * @returns {(this: object, key: string, value: unknown) => unknown}
 */
function nameAssets (assetNames) {
  return function (key, value) {
    const original = this[key]
    if (typeof original !== 'object' || original === null) return value

    const name = assetNames.get(original)
    if (name !== undefined) return name

    if (TEXT_WITH_ASSETS in original) {
      let { text } = original
      for (const asset of original.assets) {
        const assetName = assetNames.get(asset)
        if (assetName !== undefined) text = text.replaceAll(String(asset), assetName)
      }
      return text
    }
    return value
  }
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
