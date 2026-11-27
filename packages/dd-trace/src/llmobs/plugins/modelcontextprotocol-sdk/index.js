'use strict'

const LLMObsPlugin = require('../base')
const {
  formatInput,
  formatOutput,
  formatServerInput,
  getClientInfoTags,
  injectTelemetrySchema,
  safeStringify,
  stripTelemetry,
} = require('./utils')

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

    this._tagger.tagTextIO(span, null, safeStringify(ctx.result))
  }
}

class McpServerRequestLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_server_request'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:apm:mcp:server:request'

  getLLMObsSpanRegisterOptions (ctx) {
    const { request } = ctx
    if (request?.method === 'tools/call') {
      return { kind: 'tool', name: request.params?.name || 'unknown_tool' }
    }
    return { kind: 'task', name: `mcp.${request?.method ?? 'unknown'}` }
  }

  /**
   * With intent capture, tools/list results ask the model for a `telemetry.intent` argument, and tools/call requests
   * reach the tool without it. The instrumentation passes `ctx.request` to the handler and applies
   * `ctx.transformResult` to its result.
   *
   * @param {object} ctx
   */
  start (ctx) {
    super.start(ctx)
    if (!ctx.llmobs || !this._tracerConfig.mcp?.DD_MCP_CAPTURE_INTENT) return

    const method = ctx.request?.method
    const isList = method === 'tools/list'
    const getTool = (isList || method === 'tools/call') && ctx.managedToolResolver(ctx.server)
    if (!getTool) return
    if (isList) {
      ctx.transformResult = result => injectTelemetrySchema(result, getTool)
    } else {
      const stripped = stripTelemetry(ctx.request, getTool)
      if (!stripped) return
      ctx.request = stripped.request
      ctx.llmobs.intent = stripped.intent
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    if (ctx.llmobs?.intent) this._tagger.tagIntent(span, ctx.llmobs.intent)

    const { request, extra, server } = ctx
    const spanTags = {
      mcp_method: request?.method,
      ...getClientInfoTags(extra?.mcpReq?.envelope, server),
    }
    const sessionId = extra?.sessionId ?? server?.transport?.sessionId
    if (sessionId) spanTags.mcp_session_id = String(sessionId)
    if (request?.method === 'tools/call') {
      spanTags.mcp_tool = request.params?.name || 'unknown_tool'
      spanTags.mcp_tool_kind = 'server'
    }
    this._tagger.tagSpanTags(span, spanTags)

    const output = ctx.error ? undefined : safeStringify(ctx.result)
    this._tagger.tagTextIO(span, formatServerInput(request, extra?.mcpReq), output)
  }
}

class McpToolCallV2LLMObsPlugin extends McpToolCallLLMObsPlugin {
  static id = 'llmobs_mcp_tool_call_v2'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/client:Client_callTool'
}

class McpListToolsV2LLMObsPlugin extends McpListToolsLLMObsPlugin {
  static id = 'llmobs_mcp_list_tools_v2'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/client:Client_listTools'
}

module.exports = [
  McpToolCallLLMObsPlugin,
  McpListToolsLLMObsPlugin,
  McpToolCallV2LLMObsPlugin,
  McpListToolsV2LLMObsPlugin,
  McpServerRequestLLMObsPlugin,
]
