'use strict'

/**
 * Extracts chat templates from OpenAI response instructions by replacing variable values with placeholders.
 *
 * Takes the rendered instructions from an OpenAI response and reverse-engineers the original template
 * by replacing actual variable values with their placeholder names (e.g., "Hello John" -> "Hello {{name}}").
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

  // Build map of values to placeholders
  const valueToPlaceholder = {}
  for (const [varName, varValue] of Object.entries(variables)) {
    // Handle ResponseInputText objects (have .text property) or plain strings
    const valueStr = (varValue && typeof varValue === 'object' && varValue.text)
      ? varValue.text
      : varValue
    if (!valueStr) continue
    valueToPlaceholder[String(valueStr)] = `{{${varName}}}`
  }

  // Sort values by length (longest first) to handle overlapping values correctly
  const sortedValues = Object.keys(valueToPlaceholder).sort((a, b) => b.length - a.length)

  for (const instruction of instructions) {
    const role = instruction.role
    if (!role) continue

    const contentItems = instruction.content
    if (!Array.isArray(contentItems)) continue

    // Collect text parts from content items
    const textParts = []
    for (const contentItem of contentItems) {
      if (contentItem.text) {
        textParts.push(contentItem.text)
      }
    }
    if (textParts.length === 0) continue

    // Combine all text parts and replace variable values with placeholders (longest first)
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

module.exports = {
  extractChatTemplateFromInstructions
}

