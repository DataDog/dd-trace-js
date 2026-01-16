'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class BaseModelcontextprotocolSdkServerPlugin extends TracingPlugin {
  static id = 'modelcontextprotocol-sdk'
  static operation = 'request'
  static system = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_connect'
  static spanName = 'modelcontextprotocol-sdk.server.connect'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    return {
      component: 'modelcontextprotocol-sdk',
      'span.kind': 'server'
    }
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    span?.finish()
  }
}

class McpServerClosePlugin extends BaseModelcontextprotocolSdkServerPlugin {
  static id = 'mcp_server_close'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_close'
  static spanName = 'modelcontextprotocol-sdk.server.close'
}

class McpServerExecuteToolHandlerPlugin extends BaseModelcontextprotocolSdkServerPlugin {
  static id = 'mcp_server_executeToolHandler'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_executeToolHandler'
  static spanName = 'modelcontextprotocol-sdk.server.executeToolHandler'
}

module.exports = {
  BaseModelcontextprotocolSdkServerPlugin,
  McpServerClosePlugin,
  McpServerExecuteToolHandlerPlugin
}
