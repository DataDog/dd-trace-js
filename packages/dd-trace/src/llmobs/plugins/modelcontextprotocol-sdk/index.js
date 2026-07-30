'use strict'

const LLMObsPlugin = require('../base')
const {
  formatOutput,
  formatServerRequestInput,
  formatServerRequestOutput,
  formatToolInput,
  getInitializeClientInfo,
  getRequestToolName,
  getServerRequestSessionId,
} = require('./utils')

class McpClientInitializeLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_client_initialize'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:apm:mcp:client:initialize'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'task',
      name: 'MCP Client Initialize',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span || ctx.error) return

    this._tagger.tagTextIO(span, undefined, formatServerRequestOutput(ctx.result))
  }
}

class McpToolCallLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'

  getLLMObsSpanRegisterOptions (ctx) {
    const toolName = getRequestToolName(ctx.arguments?.[0])
    return {
      kind: 'tool',
      name: `MCP Client Tool Call: ${toolName}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const toolArguments = params?.arguments
    const spanTags = { mcp_tool_kind: 'client' }

    const serverVersion = ctx.self?.getServerVersion?.()
    if (serverVersion?.name) spanTags.mcp_server_name = serverVersion.name

    this._tagger.tagSpanTags(span, spanTags)
    this._tagger.tagTextIO(span, formatToolInput(toolArguments), ctx.result ? formatOutput(ctx.result) : undefined)
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
    if (!span || ctx.error) return

    const cursor = ctx.arguments?.[0]?.cursor ?? null

    this._tagger.tagTextIO(span, JSON.stringify({ cursor }), formatServerRequestOutput(ctx.result))
  }
}

class McpServerRequestLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_server_request'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:apm:mcp:server:request'

  getLLMObsSpanRegisterOptions (ctx) {
    const method = ctx.request?.method || 'unknown'
    if (method === 'initialize') {
      return {
        kind: 'task',
        name: 'mcp.initialize',
      }
    }

    if (method === 'tools/call') {
      return {
        kind: 'tool',
        name: getRequestToolName(ctx.request?.params),
      }
    }

    return {
      kind: 'task',
      name: `MCP Server Request: ${method}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const method = ctx.request?.method || 'unknown'
    const spanTags = { mcp_method: method }
    const sessionId = getServerRequestSessionId(ctx)
    if (sessionId) spanTags.mcp_session_id = sessionId

    const input = formatServerRequestInput(ctx.request)
    const output = formatServerRequestOutput(ctx.result)

    if (method === 'initialize') {
      const clientInfo = getInitializeClientInfo(ctx.request)
      if (clientInfo.name) spanTags.client_name = clientInfo.name
      if (clientInfo.name && clientInfo.version) {
        spanTags.client_version = `${clientInfo.name}_${clientInfo.version}`
      }
    }

    if (method === 'tools/call') {
      spanTags.mcp_tool = getRequestToolName(ctx.request?.params)
      spanTags.mcp_tool_kind = 'server'
    }

    this._tagger.tagSpanTags(span, spanTags)
    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = [
  McpClientInitializeLLMObsPlugin,
  McpToolCallLLMObsPlugin,
  McpListToolsLLMObsPlugin,
  McpServerRequestLLMObsPlugin,
]
