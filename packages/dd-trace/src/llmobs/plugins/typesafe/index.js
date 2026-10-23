'use strict'

const LLMObsPlugin = require('../base')

const IMAGE = Symbol.for('@typesafe-ai/sdk/image')
const TEXT_WITH_ASSETS = Symbol.for('@typesafe-ai/sdk/text-with-assets')
// The SDK's pattern for automatic image references, which it scans the serialized request for
const IMAGE_REFERENCE = /<image:[0-9a-f]{32}>/g
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
      ctx.llmobsRequestBody = serializeRequest(ctx.request, ctx.defaultModel, ctx.serializesAssets)
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

    const { llmobsRequestBody, result, responseText } = ctx
    const inputMessages = [{ role: 'user', content: llmobsRequestBody ?? '' }]

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
 * Rebuilds the JSON body `systemOne` sends. 0.7.0+ writes images as their alias from `assets` or their `<image:…>`
 * reference, text with assets as its text and non-finite numbers as strings, and lists the uploaded images under
 * `assets`; their bytes go in separate multipart parts and are not recorded. Earlier versions send the request as is.
 *
 * @param {object} [request]
 * @param {string} [defaultModel]
 * @param {boolean} [serializesAssets]
 */
function serializeRequest (request, defaultModel, serializesAssets) {
  if (!request || typeof request !== 'object') return
  try {
    if (!serializesAssets) return JSON.stringify({ ...request, model: request.model ?? defaultModel })

    const { assets, ...rest } = request
    const named = assets ? Object.entries(assets) : []
    const assetNames = new Map()
    for (const [name, asset] of named) assetNames.set(asset, name)

    const found = new Map()
    const json = JSON.stringify({ ...rest, model: request.model ?? defaultModel }, wireReplacer(assetNames, found))

    // Like the SDK: the named assets, then every other image in order of its first reference
    const sent = new Map(named)
    for (const [reference] of json.matchAll(IMAGE_REFERENCE)) {
      if (!sent.has(reference) && found.has(reference)) sent.set(reference, found.get(reference))
    }
    if (sent.size === 0) return json

    let part = 0
    const sentAssets = {}
    for (const [name, asset] of sent) sentAssets[name] = { type: asset.type, part: `asset-${part++}` }
    return JSON.stringify({ ...JSON.parse(json), assets: sentAssets })
  } catch {}
}

/**
 * Mirrors the SDK's serializer. Without it the span processor's object copy would skip each image's `toJSON` and
 * copy its bytes one index at a time.
 *
 * @param {Map<object, string>} assetNames - Named assets, keyed by the asset
 * @param {Map<string, object>} found - Filled with the unnamed images the request references, keyed by reference
 * @returns {(this: object, key: string, value: unknown) => unknown}
 */
function wireReplacer (assetNames, found) {
  return function (key, value) {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
    const original = this[key]
    if (typeof original !== 'object' || original === null) return value

    if (IMAGE in original) {
      const name = assetNames.get(original)
      if (name !== undefined) return name
      found.set(String(original), original)
      return value
    }

    if (TEXT_WITH_ASSETS in original) {
      let { text } = original
      for (const asset of original.assets) {
        const name = assetNames.get(asset)
        if (name === undefined) found.set(String(asset), asset)
        else text = text.replaceAll(String(asset), name)
      }
      return text
    }
    return value
  }
}

module.exports = TypeSafeLLMObsPlugin
