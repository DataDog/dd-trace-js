'use strict'

const LLMObsPlugin = require('../base')
const { formatInput, formatOutput, getServerToolName } = require('./utils')

/**
 * Abstract base for MCP tool-call LLMObs plugins.
 * Subclasses implement: getLabel(), getToolName(ctx), getToolArgs(ctx), getToolKind(),
 * and optionally getExtraSpanTags(ctx).
 */
class McpBaseToolCallLLMObsPlugin extends LLMObsPlugin {
  /**
   * Returns the human-readable label prefix for span names.
   * @returns {string}
   */
  getLabel () {
    return 'MCP Tool Call'
  }

  /**
   * Extracts the tool name from context.
   * @param {object} ctx
   * @returns {string|undefined}
   */
  getToolName (ctx) {
    return undefined
  }

  /**
   * Extracts the tool arguments from context.
   * @param {object} ctx
   * @returns {object|undefined}
   */
  getToolArgs (ctx) {
    return undefined
  }

  /**
   * Returns the mcp_tool_kind tag value.
   * @returns {string}
   */
  getToolKind () {
    return 'unknown'
  }

  /**
   * Returns extra span tags to merge in addition to mcp_tool_kind.
   * @param {object} ctx
   * @returns {object}
   */
  getExtraSpanTags (ctx) {
    return {}
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const toolName = this.getToolName(ctx) || 'unknown_tool'
    return {
      kind: 'tool',
      name: `${this.getLabel()}: ${toolName}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const toolName = this.getToolName(ctx)
    const toolArguments = this.getToolArgs(ctx)
    const hasError = ctx.error || ctx.result?.isError

    const spanTags = { mcp_tool_kind: this.getToolKind(), ...this.getExtraSpanTags(ctx) }
    this._tagger.tagSpanTags(span, spanTags)

    const input = formatInput(toolName, toolArguments)
    const output = hasError ? undefined : formatOutput(ctx.result)

    this._tagger.tagTextIO(span, input, output)
  }
}

class McpToolCallLLMObsPlugin extends McpBaseToolCallLLMObsPlugin {
  static id = 'llmobs_mcp_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'

  getLabel () {
    return 'MCP Client Tool Call'
  }

  getToolName (ctx) {
    return ctx.arguments?.[0]?.name
  }

  getToolArgs (ctx) {
    return ctx.arguments?.[0]?.arguments
  }

  getToolKind () {
    return 'client'
  }

  getExtraSpanTags (ctx) {
    const serverVersion = ctx.self?.getServerVersion?.()
    if (!serverVersion) return {}

    const tags = {}
    if (serverVersion.name) tags.mcp_server_name = serverVersion.name
    if (serverVersion.version) tags.mcp_server_version = serverVersion.version
    if (serverVersion.title) tags.mcp_server_title = serverVersion.title
    return tags
  }
}

class McpServerToolCallLLMObsPlugin extends McpBaseToolCallLLMObsPlugin {
  static id = 'llmobs_mcp_server_tool_call'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_executeToolHandler'

  getLabel () {
    return 'MCP Server Tool Call'
  }

  getToolName (ctx) {
    return getServerToolName(ctx)
  }

  getToolArgs (ctx) {
    // args is the second parameter to executeToolHandler (already parsed)
    return ctx.arguments?.[1]
  }

  getToolKind () {
    return 'server'
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

class McpServerRequestLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_server_request'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'apm:mcp:server:request'

  getLLMObsSpanRegisterOptions (ctx) {
    const method = ctx.request?.method || 'unknown'
    return {
      kind: 'task',
      name: `MCP Server Request: ${method}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.request?.params
    const input = params ? JSON.stringify(params) : null

    this._tagger.tagTextIO(span, input, null)
  }

  // Override finish (not asyncEnd) because apm:mcp:server:request publishes :finish
  finish (ctx) {
    if (!this._tracerConfig.llmobs?.enabled) return
    this.setLLMObsTags(ctx)
    this.end(ctx)
  }
}

module.exports = [
  McpToolCallLLMObsPlugin,
  McpServerToolCallLLMObsPlugin,
  McpListToolsLLMObsPlugin,
  McpServerRequestLLMObsPlugin,
]
