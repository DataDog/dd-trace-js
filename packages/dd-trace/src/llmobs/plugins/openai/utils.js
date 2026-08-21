'use strict'

const { UNKNOWN_MODEL_PROVIDER } = require('../../constants/tags')
const { audioMimeTypeFromFormat, formatAudioPart, imagePartFromDataUri, isDataUri } = require('../../util')
const {
  INPUT_TYPE_IMAGE,
  INPUT_TYPE_FILE,
  IMAGE_FALLBACK,
  IMAGE_TOO_LARGE_FALLBACK,
  MAX_IMAGE_CONTENT_BYTES,
  MAX_IMAGE_REFERENCE_LENGTH,
  FILE_FALLBACK,
  AUDIO_FALLBACK,
  AUDIO_MIME_TYPES,
} = require('./constants')

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g

/**
 * Extracts chat templates from OpenAI response instructions by replacing variable values with placeholders.
 *
 * Performs reverse templating: reconstructs the template by replacing actual values with {{variable_name}}.
 * For images/files: uses {{variable_name}} when values are available, falls back to [image]/[file] when stripped.
 *
 * @param {Array<object>} instructions - From Response.instructions (array of ResponseInputMessageItem)
 * @param {Record<string, string>} variables - Normalized variables (output of normalizePromptVariables)
 * @returns {Array<{role: string, content: string}>} Chat template with placeholders
 */
function extractChatTemplateFromInstructions (instructions, variables) {
  if (!Array.isArray(instructions) || !variables) return []

  const chatTemplate = []

  // Build map of values to placeholders - exclude fallback markers so they remain as-is
  const valueToPlaceholder = {}
  for (const [varName, varValue] of Object.entries(variables)) {
    // Exclude fallback markers - they should remain as [image]/[file] in the template
    if (varValue && varValue !== IMAGE_FALLBACK && varValue !== FILE_FALLBACK) {
      valueToPlaceholder[varValue] = `{{${varName}}}`
    }
  }

  // Sort values by length (longest first) to handle overlapping values correctly
  const sortedValues = Object.keys(valueToPlaceholder).sort((a, b) => b.length - a.length)

  for (const instruction of instructions) {
    const role = instruction.role
    if (!role) continue

    const contentItems = instruction.content
    if (!Array.isArray(contentItems)) continue

    // Extract text from all content items (uses actual values for images/files when available)
    const textParts = contentItems
      .map(extractTextFromContentItem)
      .filter(Boolean)

    if (textParts.length === 0) continue

    // Combine text and replace variable values with placeholders (longest first)
    let fullText = textParts.join('')
    for (const valueStr of sortedValues) {
      const placeholder = valueToPlaceholder[valueStr]
      const escapedValue = valueStr.replaceAll(REGEX_SPECIAL_CHARS, String.raw`\$&`)
      fullText = fullText.replaceAll(new RegExp(escapedValue, 'g'), placeholder)
    }

    chatTemplate.push({ role, content: fullText })
  }

  return chatTemplate
}

/**
 * Extracts text content from a content item, using actual image_url/file_id values when available.
 *
 * Used for both input messages and chat template extraction. Falls back to [image]/[file] markers
 * when the actual values are stripped (e.g., by OpenAI's default URL stripping behavior).
 *
 * @param {object} contentItem - Content item from Response.instructions[].content (ResponseInputContentItem)
 * @returns {string|null} Text content, URL/file reference, or [image]/[file] fallback marker
 */
function extractTextFromContentItem (contentItem) {
  if (!contentItem) return null

  if (contentItem.text) {
    return contentItem.text
  }

  // For image/file items, extract the actual reference value
  if (contentItem.type === INPUT_TYPE_IMAGE) {
    return contentItem.image_url || contentItem.file_id || IMAGE_FALLBACK
  }

  if (contentItem.type === INPUT_TYPE_FILE) {
    return contentItem.file_id || contentItem.file_url || contentItem.filename || FILE_FALLBACK
  }

  return null
}

/**
 * Normalizes prompt variables by extracting meaningful values from OpenAI SDK response objects.
 *
 * Converts ResponseInputText, ResponseInputImage, and ResponseInputFile objects to simple string values.
 *
 * @param {Record<string, string | object>} variables - From ResponsePrompt.variables
 * @returns {Record<string, string>} Normalized variables with simple string values
 */
function normalizePromptVariables (variables) {
  if (!variables) return {}

  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      extractTextFromContentItem(value) ?? String(value ?? ''),
    ])
  )
}

function hasMultimodalInputs (variables) {
  if (!variables) return false
  return Object.values(variables).some(value =>
    value?.type === INPUT_TYPE_IMAGE || value?.type === INPUT_TYPE_FILE
  )
}

/**
 * Decides how one OpenAI image reference is recorded.
 *
 * Returns `{ imagePart }` for an inline base64 image small enough to ship, `{ marker }` for a data
 * URI that cannot be attached — either too large, or one we could not parse — and `undefined` only
 * when the reference is not inline at all (a remote `https://` URL or a `file_id`), in which case the
 * caller keeps whatever text reference it already recorded.
 *
 * An unparseable data URI must return a marker rather than `undefined`: it still carries its entire
 * payload, so letting the caller fall back to the raw reference would splice megabytes of base64
 * into the message text, uncapped. dd-trace-py guards the same case the same way.
 *
 * Exactly one of the two fields is ever set; this is the only function that builds the result.
 *
 * @param {string | undefined} imageUrl
 * @returns {{ imagePart?: { mimeType: string, content: string }, marker?: string } | undefined}
 */
function captureInlineImage (imageUrl) {
  const imagePart = imagePartFromDataUri(imageUrl)
  if (!imagePart) return isDataUri(imageUrl) ? { marker: IMAGE_FALLBACK } : undefined

  // Measured in bytes, not UTF-16 units: valid base64 is ASCII so the two agree, but a payload with
  // multi-byte characters would otherwise pass a byte-named cap at twice the size.
  return Buffer.byteLength(imagePart.content) > MAX_IMAGE_CONTENT_BYTES
    ? { marker: IMAGE_TOO_LARGE_FALLBACK }
    : { imagePart }
}

/**
 * Flattens an array of OpenAI chat message content parts into readable text plus structured media.
 *
 * Text parts are concatenated (newline-joined). `input_audio` parts with data are captured as audio
 * parts (rendered as a player), and `image_url` parts carrying an inline base64 data URI are
 * captured as image parts (rendered inline). A remote image URL still collapses to an `[image]`
 * marker, since only the reference is available and fetching it is not the tracer's job. The
 * `[audio]` marker is only emitted as a fallback when an audio part carries no data.
 *
 * @param {Array<object>} parts - Array of content parts from a chat message `content`
 * @returns {{
 *   content: string,
 *   audioParts: Array<{ mimeType: string, content: string }>,
 *   imageParts: Array<{ mimeType: string, content: string }>,
 * }}
 */
function extractContentParts (parts) {
  const extracted = []
  const audioParts = []
  const imageParts = []

  for (const part of parts) {
    const partType = part?.type ?? ''
    if (partType === 'text') {
      extracted.push(part.text ?? '')
    } else if (partType === 'image_url') {
      // `{ url }` is the documented shape; a bare string is tolerated as the SDK accepts it.
      const captured = captureInlineImage(part.image_url?.url ?? part.image_url)
      if (captured?.imagePart) {
        // Captured as a structured image part, so no text marker is needed.
        imageParts.push(captured.imagePart)
      } else {
        extracted.push(captured?.marker ?? IMAGE_FALLBACK)
      }
    } else if (partType === 'input_audio') {
      const inputAudio = part.input_audio ?? {}
      const data = inputAudio.data
      if (data) {
        // Audio is captured as a structured audio part (rendered as a player), so no text marker
        // is needed. Only fall back to "[audio]" when there's no audio to capture.
        audioParts.push(formatAudioPart(data, audioMimeTypeFromFormat(inputAudio.format, AUDIO_MIME_TYPES)))
      } else {
        extracted.push(AUDIO_FALLBACK)
      }
    } else {
      extracted.push(`[${partType}]`)
    }
  }

  return { content: extracted.join('\n'), audioParts, imageParts }
}

/**
 * Splits a Responses-API input content array into text plus structured image parts.
 *
 * Text handling matches `extractTextFromContentItem` joined with no separator, which is what this
 * replaced. The only behavioural change is that an `input_image` carrying an inline base64 data URI
 * becomes a structured image part instead of having its entire payload spliced into the text.
 *
 * @param {Array<object>} parts - Array of content items from a Responses-API input message
 * @returns {{ content: string, imageParts: Array<{ mimeType: string, content: string }> }}
 */
function extractResponseInputContent (parts) {
  const texts = []
  const imageParts = []

  for (const part of parts) {
    if (part?.type === INPUT_TYPE_IMAGE) {
      // An `input_image` carrying alt text is off-schema but reaches us; keep the text, and capture
      // the image alongside it rather than letting one silently replace the other.
      if (part.text) texts.push(part.text)

      const captured = captureInlineImage(part.image_url)
      if (captured?.imagePart) {
        imageParts.push(captured.imagePart)
      } else if (captured?.marker) {
        texts.push(captured.marker)
      } else if (!part.text) {
        // Not inline, so record the reference itself — bounded. `captureInlineImage` only recognises
        // a well-formed `data:` URI; a payload that merely *fails* to look like one (a leading space,
        // an array that string-coerces, raw base64 with no scheme at all) would otherwise be spliced
        // in whole and uncapped. The length bound is what actually makes "a payload is never emitted
        // as text" hold, instead of relying on recognising every malformed spelling of a data URI.
        const reference = part.image_url || part.file_id
        texts.push(typeof reference === 'string' && reference.length <= MAX_IMAGE_REFERENCE_LENGTH
          ? reference
          : IMAGE_FALLBACK)
      }
      continue
    }

    const text = extractTextFromContentItem(part)
    if (text) texts.push(text)
  }

  return { content: texts.join(''), imageParts }
}

/**
 * Maps an OpenAI-compatible base URL to a model provider string. Covers
 * OpenAI, Azure OpenAI, and DeepSeek; falls back to UNKNOWN_MODEL_PROVIDER
 * for unrecognised hosts (e.g. local proxies or custom deployments).
 *
 * Shared with the openai-agents integration since both consume the same
 * client baseURL convention.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function getOpenAIModelProvider (baseUrl = '') {
  if (baseUrl.includes('azure')) return 'azure_openai'
  if (baseUrl.includes('deepseek')) return 'deepseek'
  if (baseUrl.includes('openai')) return 'openai'
  return UNKNOWN_MODEL_PROVIDER
}

module.exports = {
  extractChatTemplateFromInstructions,
  normalizePromptVariables,
  extractTextFromContentItem,
  extractContentParts,
  extractResponseInputContent,
  hasMultimodalInputs,
  getOpenAIModelProvider,
}
