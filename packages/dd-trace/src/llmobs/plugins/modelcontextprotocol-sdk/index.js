'use strict'

const LLMObsPlugin = require('../base')

class McpToolCallLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'

  getLLMObsSpanRegisterOptions (ctx) {
    const params = ctx.arguments?.[0]
    const toolName = params?.name || 'tool'

    return {
      kind: 'tool',
      name: `mcp.tool.${toolName}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const toolName = params?.name
    const toolArguments = params?.arguments
    const serverName = ctx.self?._serverVersion?.name

    const input = formatInput(toolName, toolArguments)
    const output = ctx.error ? undefined : formatOutput(ctx.result)

    this._tagger.tagTextIO(span, input, output)

    const metadata = {}
    if (toolName) metadata['mcp.tool.name'] = toolName
    if (serverName) metadata['mcp.server.name'] = serverName

    if (Object.keys(metadata).length > 0) {
      this._tagger.tagMetadata(span, metadata)
    }
  }
}

/**
 * Formats tool call input as a text string.
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

module.exports = [McpToolCallLLMObsPlugin]
