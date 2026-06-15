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

class McpServerRequestPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_server'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Protocol__onrequest'

  bindStart (ctx) {
    const [request, extra] = ctx.arguments || []
    const method = request?.method
    const headers = extra?.requestInfo?.headers

    // Extract distributed trace context from HTTP transport headers when available
    const childOf = headers ? this.tracer.extract('http_headers', headers) : null

    this.startSpan('mcp.server.request', {
      childOf,
      resource: method,
      type: 'mcp',
      kind: 'server',
    }, ctx)

    return ctx.currentStore
  }

  end (ctx) {
    super.finish(ctx)
  }
}

class McpServerToolCallPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol_server_tool'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_executeToolHandler'

  bindStart (ctx) {
    const [tool] = ctx.arguments || []
    const toolName = tool?.name

    this.startSpan('mcp.server.tool.call', {
      resource: toolName,
      type: 'mcp',
      kind: 'internal',
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const result = ctx.result
    if (result?.isError) {
      const span = ctx.currentStore?.span
      const errorText = result.content?.find?.(c => c.type === 'text')?.text || 'Tool handler returned isError: true'
      span?.setTag('error', new Error(errorText))
    }
    super.finish(ctx)
  }
}

module.exports = [
  McpToolCallPlugin,
  McpListToolsPlugin,
  McpServerRequestPlugin,
  McpServerToolCallPlugin,
]
