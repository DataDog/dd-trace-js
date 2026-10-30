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
    const toolArguments = params?.arguments

    const spanTags = { mcp_tool_kind: 'client' }

    const serverVersion = ctx.self?.getServerVersion?.()
    if (serverVersion) {
      if (serverVersion.name) spanTags.mcp_server_name = serverVersion.name
      if (serverVersion.version) spanTags.mcp_server_version = serverVersion.version
      if (serverVersion.title) spanTags.mcp_server_title = serverVersion.title
    }

    this._tagger.tagSpanTags(span, spanTags)

    const input = formatInput(toolArguments)
    const output = ctx.result ? formatOutput(ctx.result) : undefined

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

    const cursor = ctx.arguments?.[0]?.cursor ?? null
    this._tagger.tagTextIO(span, JSON.stringify({ cursor }), JSON.stringify(ctx.result))
  }
}

class McpServerRequestLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_mcp_server_request'
  static integration = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:apm:mcp:server:request'

  getLLMObsSpanRegisterOptions (ctx) {
    const method = ctx.request?.method
    if (method === 'tools/call') {
      return {
        kind: 'tool',
        name: ctx.request.params?.name || 'unknown_tool',
      }
    }

    return {
      kind: 'task',
      name: `mcp.${method || 'unknown'}`,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const request = ctx.request
    const method = request?.method
    const name = request?.params?.name
    const tags = { mcp_method: method }

    if (method === 'tools/call') {
      tags.mcp_tool = name || 'unknown_tool'
      tags.mcp_tool_kind = 'server'
    } else if (method === 'initialize') {
      const clientInfo = request.params?.clientInfo
      if (clientInfo?.name && clientInfo.version) {
        tags.client_name = clientInfo.name
        tags.client_version = `${clientInfo.name}_${clientInfo.version}`
      }
    }
    this._tagger.tagSpanTags(span, tags)

    const input = formatServerRequest(request)
    const output = ctx.error ? undefined : safeJsonStringify(ctx.result)
    this._tagger.tagTextIO(span, input, output)
  }
}

function formatServerRequest (request) {
  if (!request || typeof request !== 'object') return '{}'
  const params = request.params && typeof request.params === 'object' ? { ...request.params } : request.params
  const metadataKey = params && Object.hasOwn(params, '_meta')
    ? '_meta'
    : params && Object.hasOwn(params, 'meta') ? 'meta' : undefined
  if (metadataKey) {
    const metadata = { ...params[metadataKey] }
    delete metadata._dd_trace_context
    if (Object.getOwnPropertyNames(metadata).length > 0) {
      params[metadataKey] = metadata
    } else {
      delete params[metadataKey]
    }
  }
  const requestCopy = { ...request }
  if (params) requestCopy.params = params
  return safeJsonStringify(requestCopy) || '{}'
}

function safeJsonStringify (value) {
  try {
    return JSON.stringify(value)
  } catch {}
}

module.exports = [McpToolCallLLMObsPlugin, McpListToolsLLMObsPlugin, McpServerRequestLLMObsPlugin]
