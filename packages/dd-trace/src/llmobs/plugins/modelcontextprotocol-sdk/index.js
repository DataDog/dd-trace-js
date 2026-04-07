'use strict'

const LLMObsPlugin = require('../base')
const { formatInput, formatOutput } = require('./utils')

class McpToolCallLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'

  getLLMObsSpanRegisterOptions (ctx) {
    const params = ctx.arguments?.[0]
    const toolName = params?.name || 'unknown_tool'

    return {
      kind: 'tool',
      name: `MCP Client Tool Call: ${toolName}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const toolName = params?.name
    const toolArguments = params?.arguments

    const input = formatInput(toolName, toolArguments)
    const output = ctx.error ? undefined : formatOutput(ctx.result)

    this._tagger.tagTextIO(span, input, output)
  }
}

class McpListToolsLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_list_tools'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listTools'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'task',
      name: 'MCP Client list Tools',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const cursor = params?.cursor

    const input = cursor === undefined ? '' : JSON.stringify({ cursor })
    const output = ctx.error ? undefined : JSON.stringify(ctx.result)

    this._tagger.tagTextIO(span, input, output)
  }
}

class McpConnectLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_connect'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_connect'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'workflow',
      name: 'MCP Client Session',
    }
  }

  setLLMObsTags () {
    // No meaningful I/O to capture for a connection lifecycle span
  }
}

module.exports = [McpToolCallLLMObsPlugin, McpListToolsLLMObsPlugin, McpConnectLLMObsPlugin]
