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
const UNPARSABLE_TOOL_RESULT = '[Unparsable Tool Result]'
const UNSUPPORTED_TOOL_RESULT = '[Unsupported Tool Result]'

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
 *   type: 'text',
 *   text: string
 * } | {
 *   type: 'media' | 'file',
 *   mediaType: string
 * } | {
 *   type: 'file-data' | 'file-url' | 'file-id' | 'file-reference'
 * } | {
 *   type: 'image-data' | 'image-url' | 'image-file-id' | 'image-file-reference'
 * } | {
 *   type: 'custom'
 * }} ToolCallContentPart
 *
 * @typedef {{
 *   type: 'text' | 'error-text',
 *   value: string
 * } | {
 *   type: 'json' | 'error-json',
 *   value: unknown
 * } | {
 *   type: 'content',
 *   value: ToolCallContentPart[]
 * } | {
 *   type: 'execution-denied',
 *   reason?: string
 * }} ToolCallOutput
 *
 * @typedef {{ output?: ToolCallOutput, result?: unknown } & Record<string, unknown>} ToolCallResultContent
 */

/**
 * A user-message content part, across every AI SDK version we instrument. An `image` part spells its
 * media type `mimeType` on v4 and `mediaType` from v5 on, so both reach us and either may be the
 * only one set. The `data` payload is only tagged on v7, and only reaches us as bytes on v7 too,
 * since v4-v6 arrive through the stringified `ai.prompt.messages` attribute.
 *
 * @typedef {{
 *   type: 'text',
 *   text?: string
 * } | {
 *   type: 'image',
 *   image?: Uint8Array | ArrayBuffer | string | URL,
 *   mediaType?: string,
 *   mimeType?: string
 * } | {
 *   type: 'file',
 *   data?: Uint8Array | ArrayBuffer | string | URL | {
 *     type: 'data' | 'url' | 'reference' | 'text',
 *     data?: Uint8Array | string
 *   },
 *   mediaType?: string,
 *   mimeType?: string
 * }} UserContentPart
 *
 * The payload an image arrives in, spelled `image` on a v4-v6 `image` part and `data` on a v7
 * `file` part. Named once so helpers can take it without indexing a single arm of the union above.
 *
 * Optional on every arm that declares it, so `undefined` is part of the type rather than a case
 * each caller has to exclude.
 *
 * @typedef {Uint8Array | ArrayBuffer | string | URL | undefined | {
 *   type: 'data' | 'url' | 'reference' | 'text',
 *   data?: Uint8Array | string
 * }} ImagePayload
 *
 * @typedef {{ mimeType: string, content: string }} LlmObsImagePart
 */

/**
 * Get the span tags from the context (either the attributes or the span tags).
 *
 * @param {AiPluginContext} ctx
 * @returns {SpanTags}
 */
function getSpanTags (ctx) {
  const span = ctx.currentStore?.span
  return /** @type {SpanTags} */ (ctx.attributes ?? span?.context().getTags() ?? {})
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
 * Supports both AI SDK v4 (promptTokens/completionTokens) and v5+
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

  // Prompt-cache metrics. AI SDK v6 standardizes cache READ tokens via
  // `ai.usage.cachedInputTokens`; cache WRITE tokens (and earlier AI SDK
  // versions / providers that don't fill `cachedInputTokens`) are only
  // available through provider-specific `ai.response.providerMetadata`.
  // Skip zero values: the AI SDK sets `cachedInputTokens=0` on every span
  // regardless of provider, so emitting it would add noise to spans that
  // don't actually use prompt caching (e.g. OpenAI).
  const providerCache = getProviderCacheTokens(tags['ai.response.providerMetadata'])

  const cacheReadTokens = tags['ai.usage.cachedInputTokens'] ?? providerCache.cacheReadTokens
  if (cacheReadTokens) usage.cacheReadTokens = cacheReadTokens

  if (providerCache.cacheWriteTokens) usage.cacheWriteTokens = providerCache.cacheWriteTokens

  // Normalize `inputTokens` to the sum convention used by `bedrockruntime.js`.
  // Some SDK combinations (e.g. `ai@5` + `@ai-sdk/amazon-bedrock@3`) pass the
  // raw fresh count through, which makes `nonCached = input - cacheRead -
  // cacheWrite` go negative downstream.
  //
  // Detection: if `inputTokens < cacheSum`, the value cannot already be a sum
  // that includes them (non-negative arithmetic). This is provider/version
  // agnostic and won't double-count on stacks where the SDK already
  // normalized (`ai@6` + `bedrock@4` / `anthropic@3`, OpenAI, Google).
  if (usage.inputTokens != null) {
    const cacheSum = (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
    if (usage.inputTokens < cacheSum) {
      usage.inputTokens += cacheSum
      if (usage.totalTokens != null) {
        usage.totalTokens = usage.inputTokens + (usage.outputTokens || 0)
      }
    }
  }

  return usage
}

/**
 * Extract prompt-cache token counts from the stringified
 * `ai.response.providerMetadata` attribute.
 *
 * The AI SDK does not standardize cache WRITE tokens on the usage object, and
 * earlier versions / providers may also omit `ai.usage.cachedInputTokens`, so
 * we read the provider-specific shape directly. Only Bedrock and Anthropic
 * are handled here as they are the providers that report cache writes today.
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
  let hasModelMetadata = false
  for (const tag of Object.keys(tags)) {
    const isModelMetadata = tag.startsWith(VERCEL_AI_MODEL_METADATA_PREFIX)
    if (isModelMetadata) {
      const lastCommaPosition = tag.lastIndexOf('.')
      const metadataKey = lastCommaPosition === -1 ? tag : tag.slice(lastCommaPosition + 1)
      if (metadataKey && MODEL_METADATA_KEYS.has(metadataKey)) {
        modelMetadata[metadataKey] = tags[tag]
        hasModelMetadata = true
      }
    } else {
      const isTelemetryMetadata = tag.startsWith(VERCEL_AI_TELEMETRY_METADATA_PREFIX)
      if (isTelemetryMetadata) {
        const metadataKey = tag.slice(VERCEL_AI_TELEMETRY_METADATA_PREFIX.length)
        if (metadataKey) {
          modelMetadata[metadataKey] = tags[tag]
          hasModelMetadata = true
        }
      }
    }
  }

  return hasModelMetadata ? modelMetadata : null
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
  let hasMetadata = false

  for (const tag of Object.keys(tags)) {
    const isGenerationMetadata = tag.startsWith(VERCEL_AI_GENERATION_METADATA_PREFIX)
    if (isGenerationMetadata) {
      const lastCommaPosition = tag.lastIndexOf('.')
      const settingKey = lastCommaPosition === -1 ? tag : tag.slice(lastCommaPosition + 1)
      const transformedKey = settingKey.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
      if (MODEL_METADATA_KEYS.has(transformedKey)) continue

      const settingValue = tags[tag]
      metadata[settingKey] = settingValue
      hasMetadata = true
    } else {
      const isTelemetryMetadata = tag.startsWith(VERCEL_AI_TELEMETRY_METADATA_PREFIX)
      if (isTelemetryMetadata) {
        const metadataKey = tag.slice(VERCEL_AI_TELEMETRY_METADATA_PREFIX.length)
        if (metadataKey) {
          metadata[metadataKey] = tags[tag]
          hasMetadata = true
        }
      }
    }
  }

  return hasMetadata ? metadata : null
}

/**
 * Get the generation metadata from the span tags (maxSteps, maxRetries, etc.)
 * Additionally, set telemetry metadata from manual telemetry tags.
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown> | null}
 */
function getGenerationMetadataFromEvent (event) {
  /** @type {Record<string, unknown>} */
  const metadata = {}

  for (const [key, value] of Object.entries(event)) {
    const transformedKey = key.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
    if (!MODEL_METADATA_KEYS.has(transformedKey)) {
      if (key === 'runtimeContext') { // custom telemetry metadata
        Object.assign(metadata, value)
      }

      continue
    }

    metadata[transformedKey] = value
  }

  // eslint-disable-next-line no-restricted-syntax -- manual tracking would duplicate Object.assign semantics
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

  const parsedToolName = Number.parseInt(toolName, 10)
  if (!Number.isNaN(parsedToolName)) return null

  return toolName
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyToolCallResult (value) {
  return JSON.stringify(value) ?? UNPARSABLE_TOOL_RESULT
}

/**
 * @param {ToolCallContentPart[]} value
 * @returns {string}
 */
function formatToolCallContent (value) {
  if (!Array.isArray(value)) return UNPARSABLE_TOOL_RESULT

  let result = ''
  for (const part of value) {
    if (typeof part !== 'object' || part === null) return UNPARSABLE_TOOL_RESULT

    const { type } = part
    if (type === 'text') {
      if (typeof part.text !== 'string') return UNPARSABLE_TOOL_RESULT
      result += part.text
    } else if (type === 'media' || type === 'file') {
      const { mediaType } = part
      if (typeof mediaType !== 'string') return UNPARSABLE_TOOL_RESULT
      result += mediaType === 'image' || mediaType.startsWith('image/') ? '[Image]' : '[File]'
    } else if (
      type === 'file-data' ||
      type === 'file-url' ||
      type === 'file-id' ||
      type === 'file-reference'
    ) {
      result += '[File]'
    } else if (
      type === 'image-data' ||
      type === 'image-url' ||
      type === 'image-file-id' ||
      type === 'image-file-reference'
    ) {
      result += '[Image]'
    } else if (type === 'custom') {
      result += '[Custom Content]'
    } else {
      return UNPARSABLE_TOOL_RESULT
    }
  }

  return result
}

/**
 * @param {ToolCallResultContent | null | undefined} content
 * @returns {string}
 */
function getToolCallResultContent (content) {
  try {
    if (typeof content !== 'object' || content === null) return UNPARSABLE_TOOL_RESULT

    const { output, result } = content
    if (output !== undefined) {
      if (typeof output !== 'object' || output === null) return UNPARSABLE_TOOL_RESULT

      const { type, value } = output
      if (type === 'text' || type === 'error-text') {
        return typeof value === 'string' ? value : UNPARSABLE_TOOL_RESULT
      } else if (type === 'json' || type === 'error-json') {
        return stringifyToolCallResult(value)
      } else if (type === 'content') {
        return formatToolCallContent(value)
      } else if (type === 'execution-denied') {
        const { reason } = output
        if (reason === undefined) return '[Tool Execution Denied]'
        return typeof reason === 'string' ? reason : UNPARSABLE_TOOL_RESULT
      }
      return UNPARSABLE_TOOL_RESULT
    }
    if (result !== undefined) {
      return typeof result === 'string' ? result : stringifyToolCallResult(result)
    }

    return UNSUPPORTED_TOOL_RESULT
  } catch {
    return UNPARSABLE_TOOL_RESULT
  }
}

/**
 * @param {unknown} mediaType
 * @returns {boolean}
 */
function isImageMediaType (mediaType) {
  return typeof mediaType === 'string' && (mediaType === 'image' || mediaType.startsWith('image/'))
}

// A base64 data URL, whose payload we can carry inline once the prefix is stripped.
const BASE64_DATA_URL = /^data:[^,]*;base64,(.*)$/is
// A reference we cannot inline: an absolute URL's scheme, or a protocol-relative `//host/path`.
const URL_REFERENCE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i
// Base64's alphabet. Separates a payload from a bare relative path once schemes are excluded.
const BASE64_ALPHABET = /^[a-z\d+/]+={0,2}$/i

/**
 * Base64-encodes an image payload, or returns undefined when there are no inline bytes to encode.
 *
 * @param {ImagePayload} data
 * @returns {string | undefined}
 */
function base64FromImageData (data) {
  // Only v7's `data` variant carries bytes; `url`, `reference` and `text` have nothing to inline.
  if (typeof data === 'object' && data !== null && 'type' in data) {
    if (data.type !== 'data') return
    data = data.data
  }

  if (Buffer.isBuffer(data) || ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('base64')
  }
  if (typeof data !== 'string') return

  // v4-v6 arrive as JSON, so both inline data URLs and remote URLs reach this field as strings.
  // A data URL still carries its bytes, so unwrap it rather than treating it as a reference.
  const inline = BASE64_DATA_URL.exec(data)
  if (inline) data = inline[1]
  else if (URL_REFERENCE.test(data)) return

  if (BASE64_ALPHABET.test(data)) return data
}

/**
 * Builds a wire image part, or returns undefined when the image cannot be carried inline.
 *
 * @param {ImagePayload} data
 * @param {unknown} mediaType
 * @returns {LlmObsImagePart | undefined}
 */
function formatImagePart (data, mediaType) {
  // The UI renders from a concrete subtype, so a bare `image` or an `image/*` wildcard (what the AI
  // SDK falls back to when its own byte sniffing fails) cannot be represented.
  if (typeof mediaType !== 'string') return
  const [topLevel, subtype] = mediaType.split('/')
  if (topLevel !== 'image' || !subtype || subtype === '*') return

  const content = base64FromImageData(data)
  if (content) return { mimeType: mediaType, content }
}

/**
 * Splits AI SDK user-message content parts into readable text plus structured image parts.
 *
 * An image the wire format can carry becomes an `imageParts` entry and contributes no text, matching
 * how audio is captured elsewhere. Remote URLs, provider references and images without a renderable
 * media type collapse to an `[Image]` marker so they stay visible instead of vanishing. Non-image
 * files keep their existing behaviour of not being represented in the text at all.
 *
 * @param {UserContentPart[] | string} parts
 * @returns {{ content: string, imageParts: LlmObsImagePart[] }}
 */
function extractUserContentParts (parts) {
  if (!Array.isArray(parts)) {
    return { content: typeof parts === 'string' ? parts : '', imageParts: [] }
  }

  let content = ''
  const imageParts = []

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text') {
      content += part.text ?? ''
      continue
    }

    // Narrowed on the literal type rather than a boolean, so `image` and `data` are each read only
    // from the arm that declares them.
    if (part.type !== 'image' && part.type !== 'file') continue

    const payload = part.type === 'image' ? part.image : part.data
    const mediaType = part.mediaType ?? part.mimeType
    if (part.type === 'file' && !isImageMediaType(mediaType)) continue

    const imagePart = formatImagePart(payload, mediaType)
    if (imagePart) {
      imageParts.push(imagePart)
    } else {
      content += '[Image]'
    }
  }

  return { content, imageParts }
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
  let hasMetadata = false

  for (const tag of Object.keys(tags)) {
    if (!tag.startsWith(VERCEL_AI_TELEMETRY_METADATA_PREFIX)) continue

    const metadataKey = tag.slice(VERCEL_AI_TELEMETRY_METADATA_PREFIX.length)
    if (metadataKey) {
      metadata[metadataKey] = tags[tag]
      hasMetadata = true
    }
  }

  return hasMetadata ? metadata : null
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
  extractUserContentParts,
  getLlmObsSpanName,
  getTelemetryMetadata,
  getGenerationMetadataFromEvent,
}
