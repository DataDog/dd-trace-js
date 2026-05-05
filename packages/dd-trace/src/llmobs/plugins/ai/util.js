'use strict'

const MODEL_METADATA_KEYS = new Set([
  'frequency_penalty',
  'max_tokens',
  'presence_penalty',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
])

const VERCEL_AI_TELEMETRY_METADATA_PREFIX = 'ai.telemetry.metadata.'
const VERCEL_AI_MODEL_METADATA_PREFIX = 'gen_ai.request.'
const VERCEL_AI_GENERATION_METADATA_PREFIX = 'ai.settings.'

/**
 * @typedef {import('../../../opentracing/span')} Span
 *
 * @typedef {string | number | boolean | null | undefined | string[] | number[] | boolean[]} TagValue
 * @typedef {Record<string, TagValue>} SpanTags
 *
 * @typedef {{ span?: Span }} CurrentStore
 * @typedef {{ currentStore?: CurrentStore, attributes?: SpanTags }} AiPluginContext
 */

/**
 * @typedef {{
 *   type: string,
 *   value?: unknown
 * }} ToolCallOutput
 *
 * @typedef {{ output?: ToolCallOutput, result?: unknown } & Record<string, unknown>} ToolCallResultContent
 */

/**
 * Get the span tags from the context (either the attributes or the span tags).
 *
 * @param {AiPluginContext} ctx
 * @returns {SpanTags}
 */
function getSpanTags (ctx) {
  const span = ctx.currentStore?.span
  const carrier = ctx.attributes ?? span?.context()._tags ?? {}
  return /** @type {SpanTags} */ (carrier)
}

/**
 * Get the operation name from the span name
 *
 * @example
 * span._name = 'ai.generateText'
 * getOperation(span) // 'generateText'
 *
 * @example
 * span._name = 'ai.generateText.doGenerate'
 * getOperation(span) // 'doGenerate'
 *
 * @param {import('../../../opentracing/span')} span
 * @returns {string | undefined}
 */
function getOperation (span) {
  const name = span._name
  if (!name) return

  return name.split('.').pop()
}

/**
 * Get the LLM token usage from the span tags.
 *
 * Supports both AI SDK v4 (promptTokens/completionTokens) and v5
 * (inputTokens/outputTokens), and surfaces prompt-cache metrics for providers
 * that report them. The AI SDK convention is that `inputTokens` already
 * includes cached tokens, so cache reads are reported as a subset of input
 * tokens rather than added on top.
 *
 * @param {SpanTags} tags
 * @returns {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   totalTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWriteTokens?: number
 * }}
 */
function getUsage (tags) {
  const usage = {}

  // AI SDK v5 uses inputTokens/outputTokens, v4 uses promptTokens/completionTokens
  // Check v5 properties first, fall back to v4
  const inputTokens = tags['ai.usage.inputTokens'] ?? tags['ai.usage.promptTokens']
  const outputTokens = tags['ai.usage.outputTokens'] ?? tags['ai.usage.completionTokens']

  if (inputTokens != null) usage.inputTokens = inputTokens
  if (outputTokens != null) usage.outputTokens = outputTokens

  // v5 provides totalTokens directly, v4 requires computation
  const totalTokens = tags['ai.usage.totalTokens'] ?? (inputTokens + outputTokens)
  if (!Number.isNaN(totalTokens)) usage.totalTokens = totalTokens

  // Prompt-cache metrics. AI SDK v5 standardizes cache READ tokens via
  // `ai.usage.cachedInputTokens`; cache WRITE tokens (and older AI SDK versions
  // / providers that haven't filled `cachedInputTokens` yet) are only available
  // through provider-specific `ai.response.providerMetadata`.
  const providerCache = getProviderCacheTokens(tags['ai.response.providerMetadata'])

  const cacheReadTokens = tags['ai.usage.cachedInputTokens'] ?? providerCache.cacheReadTokens
  if (cacheReadTokens != null) usage.cacheReadTokens = cacheReadTokens

  if (providerCache.cacheWriteTokens != null) usage.cacheWriteTokens = providerCache.cacheWriteTokens

  return usage
}

/**
 * Extract prompt-cache token counts from the stringified
 * `ai.response.providerMetadata` attribute.
 *
 * The AI SDK does not standardize cache WRITE tokens on the usage object, and
 * older versions / providers may also omit `ai.usage.cachedInputTokens`, so we
 * read the provider-specific shape directly. Only Bedrock and Anthropic are
 * handled here as they are the providers that report cache writes today.
 *
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock#cache-points
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/anthropic#cache-control
 *
 * @param {string | undefined} providerMetadataJson
 * @returns {{ cacheReadTokens?: number, cacheWriteTokens?: number }}
 */
function getProviderCacheTokens (providerMetadataJson) {
  if (!providerMetadataJson) return {}

  const metadata = getJsonStringValue(providerMetadataJson, null)
  if (!metadata || typeof metadata !== 'object') return {}

  const result = {}

  const bedrockUsage = metadata.bedrock?.usage
  if (bedrockUsage) {
    if (bedrockUsage.cacheReadInputTokens != null) result.cacheReadTokens = bedrockUsage.cacheReadInputTokens
    if (bedrockUsage.cacheWriteInputTokens != null) result.cacheWriteTokens = bedrockUsage.cacheWriteInputTokens
  }

  const anthropic = metadata.anthropic
  if (anthropic) {
    if (result.cacheReadTokens == null && anthropic.cacheReadInputTokens != null) {
      result.cacheReadTokens = anthropic.cacheReadInputTokens
    }
    if (result.cacheWriteTokens == null && anthropic.cacheCreationInputTokens != null) {
      result.cacheWriteTokens = anthropic.cacheCreationInputTokens
    }
  }

  return result
}

/**
 * Safely JSON parses a string value with a default fallback
 * @template T typeof defaultValue
 * @param {string} str
 * @param {T} defaultValue
 * @returns {Record<string, unknown> | string | Array<unknown> | null | T}
 */
function getJsonStringValue (str, defaultValue) {
  let maybeValue = defaultValue
  try {
    maybeValue = JSON.parse(str)
  } catch {
    // do nothing
  }

  return maybeValue
}

/**
 * Get the model metadata from the span tags (top_p, top_k, temperature, etc.)
 * Additionally, set telemetry metadata from manual telemetry tags.
 * @param {SpanTags} tags
 * @returns {Record<string, unknown> | null}
 */
function getModelMetadata (tags) {
  /** @type {Record<string, unknown>} */
  const modelMetadata = {}
  for (const tag of Object.keys(tags)) {
    const isModelMetadata = tag.startsWith(VERCEL_AI_MODEL_METADATA_PREFIX)
    if (isModelMetadata) {
      const lastCommaPosition = tag.lastIndexOf('.')
      const metadataKey = lastCommaPosition === -1 ? tag : tag.slice(lastCommaPosition + 1)
      if (metadataKey && MODEL_METADATA_KEYS.has(metadataKey)) {
        modelMetadata[metadataKey] = tags[tag]
      }
    } else {
      const isTelemetryMetadata = tag.startsWith(VERCEL_AI_TELEMETRY_METADATA_PREFIX)
      if (isTelemetryMetadata) {
        const metadataKey = tag.slice(VERCEL_AI_TELEMETRY_METADATA_PREFIX.length)
        if (metadataKey) {
          modelMetadata[metadataKey] = tags[tag]
        }
      }
    }
  }

  return Object.keys(modelMetadata).length ? modelMetadata : null
}

/**
 * Get the generation metadata from the span tags (maxSteps, maxRetries, etc.)
 * Additionally, set telemetry metadata from manual telemetry tags.
 * @param {SpanTags} tags
 * @returns {Record<string, unknown> | null}
 */
function getGenerationMetadata (tags) {
  /** @type {Record<string, unknown>} */
  const metadata = {}

  for (const tag of Object.keys(tags)) {
    const isGenerationMetadata = tag.startsWith(VERCEL_AI_GENERATION_METADATA_PREFIX)
    if (isGenerationMetadata) {
      const lastCommaPosition = tag.lastIndexOf('.')
      const settingKey = lastCommaPosition === -1 ? tag : tag.slice(lastCommaPosition + 1)
      const transformedKey = settingKey.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
      if (MODEL_METADATA_KEYS.has(transformedKey)) continue

      const settingValue = tags[tag]
      metadata[settingKey] = settingValue
    } else {
      const isTelemetryMetadata = tag.startsWith(VERCEL_AI_TELEMETRY_METADATA_PREFIX)
      if (isTelemetryMetadata) {
        const metadataKey = tag.slice(VERCEL_AI_TELEMETRY_METADATA_PREFIX.length)
        if (metadataKey) {
          metadata[metadataKey] = tags[tag]
        }
      }
    }
  }

  return Object.keys(metadata).length ? metadata : null
}

/**
 * Get the tool name from the span tags.
 * If the tool name is a parsable number, or is not found, null is returned.
 * Older versions of the ai sdk would tag the tool name as its index in the tools array.
 *
 * @param {SpanTags} tags
 * @returns {string | null}
 */
function getToolNameFromTags (tags) {
  const toolName = tags['ai.toolCall.name']
  if (!toolName) return null

  const parsedToolName = Number.parseInt(toolName)
  if (!Number.isNaN(parsedToolName)) return null

  return toolName
}

/**
 * Get the content of a tool call result.
 * Version 5 of the ai sdk sets this tag as `content.output`, with a `
 * @param {{ output?: { type: string, value: unknown }, result?: unknown }} content
 * @returns {string}
 */
function getToolCallResultContent (content) {
  const { output, result } = content
  if (output) {
    if (output.type === 'text') {
      return output.value
    } else if (output.type === 'json') {
      return JSON.stringify(output.value)
    }
    return '[Unparsable Tool Result]'
  } else if (result) {
    if (typeof result === 'string') {
      return result
    }

    try {
      return JSON.stringify(result)
    } catch {
      return '[Unparsable Tool Result]'
    }
  } else {
    return '[Unsupported Tool Result]'
  }
}

/**
 * Computes the LLM Observability `ai` span name
 * @param {string} operation
 * @param {string} functionId
 * @returns {string}
 */
function getLlmObsSpanName (operation, functionId) {
  return functionId ? `${functionId}.${operation}` : operation
}

/**
 * Get custom telemetry metadata from ai.telemetry.metadata.* attributes
 * @param {Record<string, unknown>} tags
 * @returns {Record<string, unknown> | null}
 */
function getTelemetryMetadata (tags) {
  const metadata = {}

  for (const tag of Object.keys(tags)) {
    if (!tag.startsWith(VERCEL_AI_TELEMETRY_METADATA_PREFIX)) continue

    const metadataKey = tag.slice(VERCEL_AI_TELEMETRY_METADATA_PREFIX.length)
    if (metadataKey) {
      metadata[metadataKey] = tags[tag]
    }
  }

  return Object.keys(metadata).length ? metadata : null
}

module.exports = {
  getSpanTags,
  getOperation,
  getUsage,
  getJsonStringValue,
  getModelMetadata,
  getGenerationMetadata,
  getToolNameFromTags,
  getToolCallResultContent,
  getLlmObsSpanName,
  getTelemetryMetadata,
}
