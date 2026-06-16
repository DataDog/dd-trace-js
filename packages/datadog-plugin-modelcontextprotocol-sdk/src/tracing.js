'use strict'

const { channel } = require('diagnostics_channel')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const toolNames = new WeakMap()
channel('apm:mcp:server:tool:registered').subscribe(({ tool, name }) => {
  toolNames.set(tool, name)
})

function setIsErrorTag (ctx) {
  const result = ctx.result
  if (result?.isError) {
    const span = ctx.currentStore?.span
    const errorText = result.content?.find?.(c => c.type === 'text')?.text || 'Tool call returned isError: true'
    span?.setTag('error', new Error(errorText))
  }
}

class McpToolCallPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_client'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'

  bindStart (ctx) {
    const params = ctx.arguments?.[0]
    const toolName = params?.name

    this.startSpan('mcp.client.tool.call', {
      resource: toolName,
      type: 'mcp',
      kind: 'client',
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    setIsErrorTag(ctx)
    super.finish(ctx)
  }
}

class McpListToolsPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_list_tools'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listTools'

  bindStart (ctx) {
    this.startSpan('mcp.tools.list', {
      resource: 'tools/list',
      type: 'mcp',
      kind: 'client',
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

class McpServerRequestPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_server'
  static prefix = 'apm:mcp:server:request'

  bindStart (ctx) {
    const { request } = ctx

    this.startSpan('mcp.server.request', {
      resource: request?.method,
      type: 'mcp',
      kind: 'server',
    }, ctx)

    const span = ctx.currentStore?.span
    const params = request?.params
    if (params?.name) {
      const tag = request.method === 'prompts/get' ? 'mcp.prompt.name' : 'mcp.tool.name'
      span?.setTag(tag, params.name)
    }
    if (params?.uri) span?.setTag('mcp.resource.uri', params.uri)
    if (params?.arguments && Object.keys(params.arguments).length) {
      span?.setTag('mcp.request.arguments', JSON.stringify(params.arguments))
    }

    return ctx.currentStore
  }

  finish (ctx) {
    const span = ctx.currentStore?.span
    if (ctx.error) span?.setTag('error', ctx.error)
    const result = ctx.result
    if (result?.tools) span?.setTag('mcp.tool.names', result.tools.map(t => t.name).join(','))
    if (result?.resources) span?.setTag('mcp.resource.uris', result.resources.map(r => r.uri).join(','))
    if (result?.prompts) {
      span?.setTag('mcp.prompt.names', result.prompts.map(p => p.name).join(','))
      const descriptions = result.prompts.map(p => p.description).filter(Boolean)
      if (descriptions.length) span?.setTag('mcp.prompt.descriptions', descriptions.join(','))
    }
    if (result?.content) {
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      if (text) span?.setTag('mcp.tool.response', text)
    }
    super.finish(ctx)
  }
}

class McpServerToolCallPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_server_tool'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_executeToolHandler'

  bindStart (ctx) {
    const [tool] = ctx.arguments || []
    const toolName = toolNames.get(tool)

    this.startSpan('mcp.server.tool.call', {
      resource: toolName,
      type: 'mcp',
      kind: 'internal',
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    setIsErrorTag(ctx)
    super.finish(ctx)
  }
}

module.exports = [
  McpToolCallPlugin,
  McpListToolsPlugin,
  McpServerRequestPlugin,
  McpServerToolCallPlugin,
]
