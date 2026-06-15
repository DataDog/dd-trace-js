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
 * Formats MCP tool call result as a structured object matching Python's output format.
 * MCP tool results contain a `content` array with items like:
 * `[{ type: 'text', text: '...' }, { type: 'image', data: '...', mimeType: '...' }]`
 * @param {object} result - The MCP CallToolResult
 * @returns {string} JSON string of `{ content: Array<{type, text, annotations, meta}>, isError: boolean }`
 */
function formatOutput (result) {
  if (!result) return ''

  const content = result.content
  const isError = result.isError || false

  const processed = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type !== 'text') continue
      const contentBlock = {
        type: item.type,
        text: item.text || '',
        annotations: item.annotations || {},
        meta: item._meta || {},
      }
      processed.push(contentBlock)
    }
  }

  try {
    return JSON.stringify({ content: processed, isError })
  } catch {
    return ''
  }
}

/**
 * Extracts a tool name from the server's registered tools map by object reference.
 * MCP server stores tools as `_registeredTools[name] = toolObject`, so we look up the
 * key whose value matches the tool object passed to the handler.
 * @param {object} ctx - The orchestrion context with `ctx.self` and `ctx.arguments`
 * @returns {string|undefined} The tool name, or undefined if not found
 */
function getServerToolName (ctx) {
  const [tool] = ctx.arguments || []
  const registeredTools = ctx.self?._registeredTools
  if (!registeredTools) return undefined
  return Object.keys(registeredTools).find(k => registeredTools[k] === tool)
}

module.exports = { formatInput, formatOutput, getServerToolName }
