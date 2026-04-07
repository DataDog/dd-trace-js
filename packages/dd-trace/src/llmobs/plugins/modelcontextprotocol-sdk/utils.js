'use strict'

/**
 * Formats tool call input as a JSON string.
 * @param {string} toolName - The name of the tool being called
 * @param {object} toolArguments - The arguments passed to the tool
 * @returns {string} Formatted input string
 */
function formatInput (toolName, toolArguments) {
  if (!toolName && !toolArguments) return ''

  if (toolArguments === undefined || toolArguments === null) {
    return toolName || ''
  }

  try {
    return JSON.stringify({ name: toolName, arguments: toolArguments })
  } catch {
    return toolName || ''
  }
}

/**
 * Formats MCP tool call result as a text string.
 * MCP tool results contain a `content` array with items like:
 * `[{ type: 'text', text: '...' }, { type: 'image', data: '...', mimeType: '...' }]`
 * @param {object} result - The MCP CallToolResult
 * @returns {string} Formatted output string
 */
function formatOutput (result) {
  if (!result) return ''

  const content = result.content
  if (!Array.isArray(content) || content.length === 0) return ''

  const parts = []
  for (const item of content) {
    if (item.type === 'text' && item.text) {
      parts.push(item.text)
    } else if (item.type === 'resource' && item.resource?.text) {
      parts.push(item.resource.text)
    }
  }

  return parts.join('\n') || ''
}

module.exports = { formatInput, formatOutput }
