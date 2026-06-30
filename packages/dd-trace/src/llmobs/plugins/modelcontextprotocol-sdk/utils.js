'use strict'

const { channel } = require('dc-polyfill')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'

const serverToolNames = new WeakMap()
channel('apm:mcp:server:tool:registered').subscribe(({ tool, name }) => {
  serverToolNames.set(tool, name)
})

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
 * Extracts a tool name from the server tool object passed to the handler.
 * @param {object} ctx - The orchestrion context with `ctx.self` and `ctx.arguments`
 * @returns {string|undefined} The tool name, or undefined if not found
 */
function getServerToolName (ctx) {
  return serverToolNames.get(ctx.arguments?.[0])
}

/**
 * Formats MCP server request params without internal trace propagation metadata.
 * @param {object} params - The MCP request params
 * @returns {string|null} JSON string of sanitized params, or null if nothing remains
 */
function formatServerRequestInput (params) {
  if (!params) return null

  const meta = params._meta
  if (!meta || meta[DISTRIBUTED_TRACE_META_KEY] === undefined) {
    return JSON.stringify(params)
  }

  const input = {}
  let hasInput = false

  for (const key of Object.keys(params)) {
    if (key === '_meta') continue

    input[key] = params[key]
    hasInput = true
  }

  const sanitizedMeta = {}
  let hasMeta = false

  for (const key of Object.keys(meta)) {
    if (key === DISTRIBUTED_TRACE_META_KEY) continue

    sanitizedMeta[key] = meta[key]
    hasMeta = true
  }

  if (hasMeta) {
    input._meta = sanitizedMeta
    hasInput = true
  }

  return hasInput ? JSON.stringify(input) : null
}

module.exports = { formatInput, formatOutput, formatServerRequestInput, getServerToolName }
