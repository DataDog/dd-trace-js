'use strict'

const { storage } = require('../../storage')

const LLMObsPlugin = require('../base')
const { formatInput, formatOutput } = require('./utils')

const listToolsTraces = new WeakMap()
const MCP_ADAPTER_TOOL = Symbol.for('dd-trace:langchain:mcp-adapter-tool')

class McpToolCallLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'

  getLLMObsSpanRegisterOptions (ctx) {
    // LangChain's Tool.invoke() is the canonical LLMObs tool span for adapter calls.
    // Keep MCP's APM span for protocol visibility and propagation, but avoid duplicating its I/O payload.
    if (storage.getStore()?.span?.[MCP_ADAPTER_TOOL]) return

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

  getLLMObsSpanRegisterOptions (ctx) {
    const trace = ctx.currentStore?.span?.context()._trace
    if (trace && listToolsTraces.has(trace)) return

    return {
      kind: 'task',
      name: 'MCP Client List Tools',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span || ctx.error) return

    this._tagger.tagTextIO(span, null, JSON.stringify(ctx.result))
    listToolsTraces.set(span.context()._trace, true)
  }
}

module.exports = [McpToolCallLLMObsPlugin, McpListToolsLLMObsPlugin]
