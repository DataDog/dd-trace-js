'use strict'

const { forPackage } = require('../../../../../datadog-plugin-modelcontextprotocol-sdk/src/utils')
const LLMObsPlugin = require('../base')
const { formatInput, formatOutput, formatServerInput, getClientInfoTags } = require('./utils')

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

    const spanTags = { mcp_tool_kind: 'client' }

    const serverVersion = ctx.self?.getServerVersion?.()
    if (serverVersion) {
      if (serverVersion.name) spanTags.mcp_server_name = serverVersion.name
      if (serverVersion.version) spanTags.mcp_server_version = serverVersion.version
      if (serverVersion.title) spanTags.mcp_server_title = serverVersion.title
    }

    this._tagger.tagSpanTags(span, spanTags)

    const hasError = ctx.error || ctx.result?.isError
    const input = formatInput(toolName, toolArguments)
    const output = hasError ? undefined : formatOutput(ctx.result)

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
      name: 'MCP Client List Tools',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span || ctx.error) return

    this._tagger.tagTextIO(span, null, JSON.stringify(ctx.result))
  }
}

// SDK 2.x server: one tool span per tools/call request, on the server request span.
class McpServerToolCallLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_server_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/server:Protocol__onrequest'

  getLLMObsSpanRegisterOptions (ctx) {
    const request = ctx.arguments?.[0]
    if (request?.method !== 'tools/call') return

    return {
      kind: 'tool',
      name: request.params?.name || 'unknown_tool',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const request = ctx.arguments?.[0]
    if (!span || request?.method !== 'tools/call') return

    const spanTags = {
      mcp_method: request.method,
      mcp_tool: request.params?.name || 'unknown_tool',
      mcp_tool_kind: 'server',
      ...getClientInfoTags(request, ctx.self),
    }
    const sessionId = ctx.handlerContext?.sessionId
    if (sessionId) spanTags.mcp_session_id = String(sessionId)

    this._tagger.tagSpanTags(span, spanTags)

    let output
    if (!ctx.error && ctx.result !== undefined) {
      try {
        output = JSON.stringify(ctx.result)
      } catch {}
    }
    this._tagger.tagTextIO(span, formatServerInput(request), output)
  }
}

const clientPlugins = [McpToolCallLLMObsPlugin, McpListToolsLLMObsPlugin]

module.exports = [
  ...clientPlugins,
  ...clientPlugins.map(Plugin => forPackage(Plugin, '@modelcontextprotocol/client')),
  McpServerToolCallLLMObsPlugin,
]
