'use strict'

// Token counts for the usage metrics, in the convention the metrics require: input tokens include cache reads and
// writes, and output tokens include reasoning.
//
// AI SDK 6 and later (provider specification v3 and v4) already report usage that way: `inputTokens.total` and
// `outputTokens.total`. AI SDK 5 (specification v2) passes each provider's own counts through, and they differ:
//
// - Anthropic (`@ai-sdk/anthropic@2`) reports `input_tokens`, which leaves out cache reads and writes. Writes appear
//   only in `providerMetadata.anthropic`, next to the raw usage.
// - Amazon Bedrock (`@ai-sdk/amazon-bedrock@3`) reports Converse's `inputTokens`, which also leaves out cache reads
//   and writes. Writes appear only in `providerMetadata.bedrock.usage`.
// - Gemini (`@ai-sdk/google@2`, also on Vertex) reports `candidatesTokenCount` as output, which leaves out
//   `thoughtsTokenCount`, reported separately as `reasoningTokens`.
// - OpenAI and the OpenAI-compatible providers report `prompt_tokens` and `completion_tokens`, which already include
//   cached input and reasoning.
//
// Through AI Gateway the AI SDK provider is `gateway`, so the convention is read from the provider metadata the call
// returns, and otherwise from the provider the gateway routed to and the model's creator.

/**
 * @typedef {'v2' | 'v3'} UsageSpecification `v2` for AI SDK 4 and 5, `v3` for the normalized usage of AI SDK 6 and
 *   later
 *
 * @typedef {{
 *   specification: UsageSpecification,
 *   inputTokens?: unknown,
 *   outputTokens?: unknown,
 *   reasoningTokens?: unknown,
 *   cacheReadTokens?: unknown,
 *   cacheWriteTokens?: unknown
 * }} ReportedUsage the usage as the AI SDK reports it: each value is checked before use
 *
 * @typedef {{ lifetime: '5m' | '1h' | 'unspecified', tokens: number }} CacheWrite
 *
 * @typedef {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWrites: CacheWrite[]
 * }} TokenUsage
 *
 * @typedef {'anthropic' | 'bedrock' | 'gemini' | 'inclusive'} UsageConvention
 *
 * @typedef {{
 *   inputTokens?: { total?: unknown, cacheRead?: unknown, cacheWrite?: unknown },
 *   outputTokens?: { total?: unknown, reasoning?: unknown }
 * }} LanguageModelUsage specification v3 and v4 usage
 *
 * @typedef {{
 *   promptTokenCount?: unknown,
 *   candidatesTokenCount?: unknown,
 *   thoughtsTokenCount?: unknown,
 *   cachedContentTokenCount?: unknown
 * }} GeminiUsageMetadata
 *
 * The provider metadata, as far as it is read here. It is parsed JSON, so every value is checked before use.
 * @typedef {{
 *   anthropic?: {
 *     cacheCreationInputTokens?: unknown,
 *     usage?: {
 *       input_tokens?: unknown,
 *       cache_read_input_tokens?: unknown,
 *       cache_creation_input_tokens?: unknown,
 *       cache_creation?: { ephemeral_5m_input_tokens?: unknown, ephemeral_1h_input_tokens?: unknown }
 *     }
 *   },
 *   bedrock?: {
 *     usage?: { cacheReadInputTokens?: unknown, cacheWriteInputTokens?: unknown, cacheDetails?: unknown }
 *   },
 *   google?: { usageMetadata?: GeminiUsageMetadata },
 *   vertex?: { usageMetadata?: GeminiUsageMetadata }
 * }} ProviderMetadata
 */

/**
 * @param {unknown} count
 * @returns {count is number}
 */
function isCount (count) {
  return Number.isInteger(count) && /** @type {number} */ (count) >= 0
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObject (value) {
  return typeof value === 'object' && value !== null
}

/**
 * The usage an AI SDK 4 to 6 `doGenerate` or `doStream` span reports.
 *
 * AI SDK 6 records the specification v3 breakdown as `ai.usage.inputTokenDetails.*` and `ai.usage.outputTokenDetails.*`
 * and its totals as `ai.usage.inputTokens` and `ai.usage.outputTokens`. AI SDK 5 never records those details: it
 * names a `doGenerate` span's counts `ai.usage.promptTokens` and `ai.usage.completionTokens`, and a `doStream` span's
 * `ai.usage.inputTokens` and `ai.usage.outputTokens`, with `ai.usage.cachedInputTokens` and `ai.usage.reasoningTokens`.
 *
 * @param {Record<string, unknown>} tags
 * @returns {ReportedUsage}
 */
function spanUsage (tags) {
  const details = Object.keys(tags).some(key =>
    key.startsWith('ai.usage.inputTokenDetails.') || key.startsWith('ai.usage.outputTokenDetails.'))

  if (details) {
    return {
      specification: 'v3',
      inputTokens: tags['ai.usage.inputTokens'],
      outputTokens: tags['ai.usage.outputTokens'],
      reasoningTokens: tags['ai.usage.outputTokenDetails.reasoningTokens'] ?? tags['ai.usage.reasoningTokens'],
      cacheReadTokens: tags['ai.usage.inputTokenDetails.cacheReadTokens'] ?? tags['ai.usage.cachedInputTokens'],
      cacheWriteTokens: tags['ai.usage.inputTokenDetails.cacheWriteTokens'],
    }
  }

  return {
    specification: 'v2',
    inputTokens: tags['ai.usage.inputTokens'] ?? tags['ai.usage.promptTokens'],
    outputTokens: tags['ai.usage.outputTokens'] ?? tags['ai.usage.completionTokens'],
    reasoningTokens: tags['ai.usage.reasoningTokens'],
    cacheReadTokens: tags['ai.usage.cachedInputTokens'],
  }
}

/**
 * The usage of an AI SDK 7 `languageModelCall`: the provider's specification v3 or v4 usage, which is normalized.
 *
 * @param {unknown} usage
 * @returns {ReportedUsage}
 */
function languageModelUsage (usage) {
  const { inputTokens, outputTokens } = /** @type {LanguageModelUsage} */ (isObject(usage) ? usage : {})
  return {
    specification: 'v3',
    inputTokens: inputTokens?.total,
    outputTokens: outputTokens?.total,
    reasoningTokens: outputTokens?.reasoning,
    cacheReadTokens: inputTokens?.cacheRead,
    cacheWriteTokens: inputTokens?.cacheWrite,
  }
}

/**
 * Which provider's usage convention a specification v2 call follows: first from the provider metadata the provider
 * attached, then from the provider AI Gateway routed to and the model's creator.
 *
 * @param {ProviderMetadata} metadata
 * @param {GeminiUsageMetadata | undefined} geminiUsage
 * @param {unknown} provider AI Gateway provider slug, such as `anthropic`, `bedrock` or `vertex`
 * @param {unknown} model model id, such as `anthropic/claude-sonnet-4.5`
 * @returns {UsageConvention}
 */
function usageConvention (metadata, geminiUsage, provider, model) {
  if (isObject(metadata.anthropic)) return 'anthropic'
  if (isObject(metadata.bedrock)) return 'bedrock'
  if (geminiUsage) return 'gemini'

  if (provider === 'anthropic') return 'anthropic'
  if (provider === 'bedrock') return 'bedrock'
  if (provider === 'google') return 'gemini'

  // Vertex serves several creators' models, and without routing only the model id is known.
  if (provider === undefined || provider === 'vertex') {
    const creator = typeof model === 'string' ? model.split('/', 1)[0] : undefined
    if (creator === 'anthropic') return 'anthropic'
    if (creator === 'google') return 'gemini'
  }

  return 'inclusive'
}

/**
 * The cache writes split by the lifetimes the provider reports, with the rest as `unspecified`.
 *
 * Anthropic reports them as `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` in its raw
 * usage, which `providerMetadata.anthropic.usage` carries; Bedrock as `cacheDetails: [{ ttl, inputTokens }]` in
 * `providerMetadata.bedrock.usage`.
 *
 * @param {number | undefined} total
 * @param {ProviderMetadata} metadata
 * @returns {CacheWrite[]}
 */
function cacheWrites (total, metadata) {
  if (!total) return []

  /** @type {CacheWrite[]} */
  const parts = []
  const creation = metadata.anthropic?.usage?.cache_creation
  const cacheDetails = metadata.bedrock?.usage?.cacheDetails
  if (creation && typeof creation === 'object') {
    const { ephemeral_5m_input_tokens: fiveMinutes, ephemeral_1h_input_tokens: oneHour } = creation
    if (isCount(fiveMinutes)) parts.push({ lifetime: '5m', tokens: fiveMinutes })
    if (isCount(oneHour)) parts.push({ lifetime: '1h', tokens: oneHour })
  } else if (Array.isArray(cacheDetails)) {
    for (const detail of cacheDetails) {
      const lifetime = detail?.ttl
      if ((lifetime === '5m' || lifetime === '1h') && isCount(detail.inputTokens)) {
        parts.push({ lifetime, tokens: detail.inputTokens })
      }
    }
  }

  const reported = parts.filter(part => part.tokens > 0)
  const sum = reported.reduce((acc, part) => acc + part.tokens, 0)
  // parts that add up to more than the total are not a split of it
  if (sum > total) return [{ lifetime: 'unspecified', tokens: total }]
  if (sum < total) reported.push({ lifetime: 'unspecified', tokens: total - sum })
  return reported
}

/**
 * The call's token usage in the metrics' convention.
 *
 * @param {ReportedUsage} usage
 * @param {{ providerMetadata?: unknown, provider?: unknown, model?: unknown }} context
 * @returns {TokenUsage}
 */
function normalizeUsage (usage, { providerMetadata, provider, model }) {
  const metadata = /** @type {ProviderMetadata} */ (isObject(providerMetadata) ? providerMetadata : {})
  const anthropicUsage = metadata.anthropic?.usage
  const bedrockUsage = metadata.bedrock?.usage
  const geminiUsage = [metadata.google?.usageMetadata, metadata.vertex?.usageMetadata].find(isObject)

  let inputTokens = isCount(usage.inputTokens) ? usage.inputTokens : undefined
  let outputTokens = isCount(usage.outputTokens) ? usage.outputTokens : undefined

  // The counts the SDK normalized come first. AI SDK 5 leaves cache writes, and on a `doGenerate` span cache reads
  // too, to the provider metadata.
  const cacheReadTokens = [
    usage.cacheReadTokens,
    anthropicUsage?.cache_read_input_tokens,
    bedrockUsage?.cacheReadInputTokens,
    geminiUsage?.cachedContentTokenCount,
  ].find(isCount)
  const cacheWriteTokens = [
    usage.cacheWriteTokens,
    metadata.anthropic?.cacheCreationInputTokens,
    anthropicUsage?.cache_creation_input_tokens,
    bedrockUsage?.cacheWriteInputTokens,
  ].find(isCount)

  if (usage.specification === 'v2') {
    const convention = usageConvention(metadata, geminiUsage, provider, model)
    const cached = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)

    if (inputTokens !== undefined && cached > 0) {
      if (convention === 'bedrock') {
        inputTokens += cached
      } else if (convention === 'anthropic') {
        // Anthropic's raw `input_tokens` excludes the cache. The reported count already includes it only if it adds
        // up to the raw total, as when a gateway normalized the usage itself.
        const fresh = anthropicUsage?.input_tokens
        if (!isCount(fresh) || inputTokens !== fresh + cached) inputTokens += cached
      }
    }

    if (outputTokens !== undefined && convention === 'gemini') {
      const reasoningTokens = [usage.reasoningTokens, geminiUsage?.thoughtsTokenCount].find(isCount)
      // Gemini's `candidatesTokenCount` excludes the thoughts. The reported count includes them already if it is
      // not that count, as when a gateway normalized the usage itself.
      const candidates = geminiUsage?.candidatesTokenCount
      if (reasoningTokens && (!isCount(candidates) || outputTokens === candidates)) outputTokens += reasoningTokens
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrites: cacheWrites(cacheWriteTokens, metadata),
  }
}

module.exports = {
  languageModelUsage,
  normalizeUsage,
  spanUsage,
}
