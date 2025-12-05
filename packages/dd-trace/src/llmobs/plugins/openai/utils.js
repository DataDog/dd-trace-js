'use strict'

const IMAGE_FALLBACK = '[image]'
const FILE_FALLBACK = '[file]'

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g

/**
 * Extracts chat templates from OpenAI response instructions by replacing variable values with placeholders.
 *
 * Performs reverse templating: reconstructs the template by replacing actual values with {{variable_name}}.
 * For images/files: uses {{variable_name}} when values are available, falls back to [image]/[file] when stripped.
 *
 * @param {Array<Object>} instructions - From Response.instructions (array of ResponseInputMessageItem)
 * @param {Object<string, string>} variables - Normalized variables (output of normalizePromptVariables)
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
 * @param {Object} contentItem - Content item from Response.instructions[].content (ResponseInputContentItem)
 * @returns {string|null} Text content, URL/file reference, or [image]/[file] fallback marker
 */
function extractTextFromContentItem (contentItem) {
  if (!contentItem) return null

  if (contentItem.text) {
    return contentItem.text
  }

  // For image/file items, extract the actual reference value
  if (contentItem.type === 'input_image') {
    return contentItem.image_url || contentItem.file_id || IMAGE_FALLBACK
  }

  if (contentItem.type === 'input_file') {
    return contentItem.file_id || contentItem.file_url || contentItem.filename || FILE_FALLBACK
  }

  return null
}

/**
 * Normalizes prompt variables by extracting meaningful values from OpenAI SDK response objects.
 *
 * Converts ResponseInputText, ResponseInputImage, and ResponseInputFile objects to simple string values.
 *
 * @param {Object<string, string|Object>} variables - From ResponsePrompt.variables
 * @returns {Object<string, string>} Normalized variables with simple string values
 */
function normalizePromptVariables (variables) {
  if (!variables) return {}

  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      extractTextFromContentItem(value) ?? String(value ?? '')
    ])
  )
}

module.exports = {
  extractChatTemplateFromInstructions,
  normalizePromptVariables,
  extractTextFromContentItem
}
