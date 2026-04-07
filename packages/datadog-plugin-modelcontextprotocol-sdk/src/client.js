'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class BaseModelcontextprotocolSdkClientPlugin extends ClientPlugin {
  static id = 'modelcontextprotocol_client'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'
  static peerServicePrecursors = ['mcp.server.name']

  bindStart (ctx) {
    const params = ctx.arguments?.[0]
    const toolName = params?.name
    const toolArguments = params?.arguments
    const serverName = ctx.self?._serverVersion?.name

    const meta = {
      'ai.operation': 'tool_call',
      'mcp.tool.name': toolName,
      'mcp.operation': 'tools/call',
      'mcp.server.name': serverName,
    }

    if (toolArguments !== undefined) {
      meta['mcp.tool.arguments'] = JSON.stringify(toolArguments)
    }

    this.startSpan('mcp.tool.call', {
      resource: toolName,
      type: 'llm',
      kind: 'client',
      meta,
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

class ProtocolRequestPlugin extends BaseModelcontextprotocolSdkClientPlugin {
  static id = 'modelcontextprotocol_request'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Protocol_request'

  bindStart (ctx) {
    const request = ctx.arguments?.[0]
    const method = request?.method
    const serverName = ctx.self?._serverVersion?.name
    const requestId = ctx.self?._requestMessageId

    const meta = {
      'rpc.system': 'jsonrpc',
      'rpc.jsonrpc.version': '2.0',
      'mcp.method': method,
      'mcp.server.name': serverName,
    }

    if (requestId !== undefined) {
      meta['mcp.request.id'] = String(requestId)
    }

    this.startSpan('mcp.request', {
      resource: method,
      type: 'http',
      kind: 'client',
      meta,
    }, ctx)

    return ctx.currentStore
  }
}

// module.exports = {
//   BaseModelcontextprotocolSdkClientPlugin,
//   ProtocolRequestPlugin,
// }
module.exports = [
  BaseModelcontextprotocolSdkClientPlugin,
  ProtocolRequestPlugin,
]
