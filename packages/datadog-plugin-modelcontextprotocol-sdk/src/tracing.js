'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

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
    const result = ctx.result
    if (result?.isError) {
      const span = ctx.currentStore?.span
      const errorText = result.content?.find?.(c => c.type === 'text')?.text || 'Tool call returned isError: true'
      span?.setTag('error', new Error(errorText))
    }
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

class McpConnectPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_connect'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_connect'

  bindStart (ctx) {
    this.startSpan('mcp.connect', {
      resource: 'connect',
      type: 'mcp',
      kind: 'client',
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

module.exports = [
  McpToolCallPlugin,
  McpListToolsPlugin,
  McpConnectPlugin,
]
