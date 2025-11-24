'use strict'

/**
 * Extracts chat templates from OpenAI response instructions by replacing text variable values with placeholders.
 *
 * Takes the rendered instructions from an OpenAI response and reverse-engineers the original template
 * by replacing actual text variable values with their placeholder names (e.g., "Hello John" -> "Hello {{name}}").
 *
 * Images and files always use generic [image] and [file] markers for deterministic templating.
 *
 * @param {Array<Object>} instructions - Array of ResponseInputMessageItem objects from OpenAI response
 *   Each instruction has: { role: string, content: Array<{type: 'input_text', text: string}>, type: 'message' }
 * @param {Object<string, string|Object>} variables - Map of variable names to values from ResponsePrompt
 *   Values can be strings or ResponseInputText objects with a .text property
 * @returns {Array<{role: string, content: string}>} Array of template messages with placeholders like {{variable_name}}
 */
function extractChatTemplateFromInstructions (instructions, variables) {
  if (!instructions || !Array.isArray(instructions)) return []
  if (!variables || typeof variables !== 'object') return []

  const chatTemplate = []

  // Build map of values to placeholders - only for text variables (exclude images/files for deterministic templates)
  const valueToPlaceholder = {}
  for (const [varName, varValue] of Object.entries(variables)) {
    const valueStr = varValue ? String(varValue) : ''
    // Only include text variables - exclude image/file markers to ensure deterministic templates
    if (valueStr && valueStr !== '[image]' && valueStr !== '[file]' && valueStr !== '[file_data]') {
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
 * Extracts text content from a content item for chat template (uses generic markers).
 *
 * Images and files always use generic markers for deterministic templating.
 *
 * @param {Object} contentItem - A content item from OpenAI response
 * @returns {string|null} The extracted text or null if no content
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
 * Extracts text content from a content item for input messages (uses actual values).
 *
 * @param {Object} contentItem - A content item from OpenAI response
 * @returns {string|null} The extracted text or null if no content
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
 * Normalizes prompt variables by extracting meaningful values from OpenAI's response objects.
 *
 * @param {Object<string, string|Object>} variables - Map of variable names to values
 * @returns {Object<string, string>} Normalized variables with simple string values
 */
function normalizePromptVariables (variables) {
  if (!variables || typeof variables !== 'object') {
    return {}
  }

  const normalized = {}
  for (const [key, value] of Object.entries(variables)) {
    let normalizedValue = value
    if (value && typeof value === 'object') {
      if (value.text !== undefined) { // ResponseInputText
        normalizedValue = value.text
      } else if (value.type === 'input_image') { // ResponseInputImage
        normalizedValue = value.image_url || value.file_id || '[image]'
      } else if (value.type === 'input_file') { // ResponseInputFile
        normalizedValue = value.file_url || value.file_id || value.filename ||
          (value.file_data ? '[file_data]' : '[file]')
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
