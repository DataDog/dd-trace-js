'use strict'

/**
 * Extracts chat templates from OpenAI response instructions by replacing text variable values with placeholders.
 *
 * Performs reverse templating: reconstructs the template by replacing actual values with {{variable_name}}.
 * Images and files always use generic [image] and [file] markers for deterministic templating.
 *
 * @param {Array<Object>} instructions - From Response.instructions (array of ResponseInputMessageItem)
 * @param {Object<string, string>} variables - Normalized variables (output of normalizePromptVariables)
 * @returns {Array<{role: string, content: string}>} Chat template with placeholders
 */
function extractChatTemplateFromInstructions (instructions, variables) {
  if (!Array.isArray(instructions) || !variables) return []

  const chatTemplate = []

  // Build map of values to placeholders - only for text variables (exclude images/files for deterministic templates)
  const valueToPlaceholder = {}
  for (const [varName, varValue] of Object.entries(variables)) {
    const valueStr = varValue ? String(varValue) : ''
    // Only include text variables - exclude image/file markers to ensure deterministic templates
    if (valueStr && valueStr !== '[image]' && valueStr !== '[file]') {
      valueToPlaceholder[valueStr] = `{{${varName}}}`
    }
  }

  // Sort values by length (longest first) to handle overlapping values correctly
  const sortedValues = Object.keys(valueToPlaceholder).sort((a, b) => b.length - a.length)

  for (const instruction of instructions) {
    const role = instruction.role
    if (!role) continue

    const contentItems = instruction.content
    if (!Array.isArray(contentItems)) continue

    // Extract text from all content items (using generic markers for template)
    const textParts = contentItems
      .map(extractTextForTemplate)
      .filter(Boolean)

    if (textParts.length === 0) continue

    // Combine text and replace variable values with placeholders (longest first)
    let fullText = textParts.join('')
    for (const valueStr of sortedValues) {
      const placeholder = valueToPlaceholder[valueStr]
      const escapedValue = valueStr.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      fullText = fullText.replaceAll(new RegExp(escapedValue, 'g'), placeholder)
    }

    chatTemplate.push({ role, content: fullText })
  }

  return chatTemplate
}

/**
 * Extracts text content for chat template (uses generic markers for images/files).
 *
 * @param {Object} contentItem - Content item from instruction.content
 * @returns {string|null} Text content, '[image]', '[file]', or null
 */
function extractTextForTemplate (contentItem) {
  // Extract text content
  if (contentItem.text) {
    return contentItem.text
  }

  // For image/file items, use generic markers for deterministic templates
  if (contentItem.type === 'input_image') {
    return '[image]'
  }

  if (contentItem.type === 'input_file') {
    return '[file]'
  }

  return null
}

/**
 * Extracts text content for input messages (uses actual image_url/file_id values).
 *
 * @param {Object} contentItem - Content item from instruction.content
 * @returns {string|null} Text content with actual URLs/file references
 */
function extractTextFromContentItem (contentItem) {
  // Extract text content
  if (contentItem.text) {
    return contentItem.text
  }

  // For image/file items, extract the actual reference value
  if (contentItem.type === 'input_image') {
    return contentItem.image_url || contentItem.file_id || '[image]'
  }

  if (contentItem.type === 'input_file') {
    return contentItem.file_id || contentItem.file_url || contentItem.filename || '[file]'
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

  const normalized = {}
  for (const [key, value] of Object.entries(variables)) {
    let normalizedValue = value
    if (value && typeof value === 'object') {
      if (value.text !== undefined) { // ResponseInputText
        normalizedValue = value.text
      } else if (value.type === 'input_image') { // ResponseInputImage
        normalizedValue = value.image_url || value.file_id || '[image]'
      } else if (value.type === 'input_file') { // ResponseInputFile
        normalizedValue = value.file_url || value.file_id || value.filename || '[file]'
      }
    }
    normalized[key] = normalizedValue
  }
  return normalized
}

module.exports = {
  extractChatTemplateFromInstructions,
  normalizePromptVariables,
  extractTextFromContentItem
}
