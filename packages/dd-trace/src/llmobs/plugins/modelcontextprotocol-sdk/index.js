'use strict'

const { LLMOBS_SUBMITTED_TAG_KEY } = require('../../constants/tags')
const { storage } = require('../../storage')

const LLMObsPlugin = require('../base')
const { formatInput, formatOutput } = require('./utils')

const listToolsTraces = new WeakMap()
const MCP_ADAPTER_TOOL = Symbol.for('dd-trace:langchain:mcp-adapter-tool')
const LIST_TOOLS_CAPTURED = Symbol('dd-trace:mcp:list-tools-captured')
const LIST_TOOLS_INITIAL_PAGE = Symbol('dd-trace:mcp:list-tools-initial-page')

/**
 * Gets the list-tools capture state for a client within a trace.
 *
 * @param {object} trace The active APM trace.
 * @param {object} client The MCP client making the request.
 * @returns {Map<string | symbol, object>} The page-to-span capture state.
 */
function getListToolsSpans (trace, client) {
  let clients = listToolsTraces.get(trace)
  if (!clients) {
    clients = new WeakMap()
    listToolsTraces.set(trace, clients)
  }

  let pages = clients.get(client)
  if (!pages) {
    pages = new Map()
    clients.set(client, pages)
  }

  return pages
}

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
    const client = ctx.self
    const params = ctx.arguments?.[0]
    const page = params?.cursor === undefined ? LIST_TOOLS_INITIAL_PAGE : params.cursor
    const spans = trace && client && getListToolsSpans(trace, client)
    const previousSpan = spans?.get(page)
    if (previousSpan) {
      const previousContext = previousSpan.context()
      if (!previousContext._isFinished ||
          (previousSpan[LIST_TOOLS_CAPTURED] && previousContext.getTag(LLMOBS_SUBMITTED_TAG_KEY) === '1')) {
        return
      }
    }

    if (spans) spans.set(page, ctx.currentStore.span)

    return {
      kind: 'task',
      name: 'MCP Client List Tools',
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span || ctx.error) return

    this._tagger.tagTextIO(span, null, JSON.stringify(ctx.result))
    span[LIST_TOOLS_CAPTURED] = true
  }
}

module.exports = [McpToolCallLLMObsPlugin, McpListToolsLLMObsPlugin]
