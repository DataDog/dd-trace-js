'use strict'

const MODEL_METADATA_KEYS = new Set([
  'frequency_penalty',
  'max_tokens',
  'presence_penalty',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences'
])

/**
 * Get the span tags from the context (either the attributes or the span tags).
 *
 * @param {Record<string, any>} ctx
 * @returns {Record<string, any>}
 */
function getSpanTags (ctx) {
  const span = ctx.currentStore?.span
  const carrier = ctx.attributes ?? span?.context()._tags ?? {}
  return carrier
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
 * @returns {string}
 */
function getOperation (span) {
  const name = span._name
  if (!name) return

  return name.split('.').pop()
}

/**
 * Get the LLM token usage from the span tags
 * @param {Record<string, string>} tags
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number}}
 */
function getUsage (tags) {
  const usage = {}
  const inputTokens = tags['ai.usage.promptTokens']
  const outputTokens = tags['ai.usage.completionTokens']

  if (inputTokens != null) usage.inputTokens = inputTokens
  if (outputTokens != null) usage.outputTokens = outputTokens

  const totalTokens = inputTokens + outputTokens
  if (!Number.isNaN(totalTokens)) usage.totalTokens = totalTokens

  return usage
}

/**
 * Safely JSON parses a string value with a default fallback
 * @param {string} str
 * @param {any} defaultValue
 * @returns {Record<string, any> | string | Array<any>}
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
 * @param {import('../../../opentracing/span')} span
 * @returns {Record<string, string> | null}
 */
function getModelMetadata (tags) {
  const modelMetadata = {}
  for (const metadata of MODEL_METADATA_KEYS) {
    const metadataTagKey = `gen_ai.request.${metadata}`
    const metadataValue = tags[metadataTagKey]
    if (metadataValue) {
      modelMetadata[metadata] = metadataValue
    }
  }

  return Object.keys(modelMetadata).length ? modelMetadata : null
}

/**
 * Get the generation metadata from the span tags (maxSteps, maxRetries, etc.)
 * @param {Record<string, string>} tags
 * @returns {Record<string, string> | null}
 */
function getGenerationMetadata (tags) {
  const metadata = {}

  for (const tag of Object.keys(tags)) {
    if (!tag.startsWith('ai.settings')) continue

    const settingKey = tag.split('.').pop()
    const transformedKey = settingKey.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
    if (MODEL_METADATA_KEYS.has(transformedKey)) continue

    const settingValue = tags[tag]
    metadata[settingKey] = settingValue
  }

  return Object.keys(metadata).length ? metadata : null
}

/**
 * Get the tool name from the span tags.
 * If the tool name is a parsable number, or is not found, null is returned.
 * Older versions of the ai sdk would tag the tool name as its index in the tools array.
 *
 * @param {Record<string, string>} tags
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
 * @param {Record<string, any>} content
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

module.exports = {
  getSpanTags,
  getOperation,
  getUsage,
  getJsonStringValue,
  getModelMetadata,
  getGenerationMetadata,
  getToolNameFromTags,
  getToolCallResultContent
}
