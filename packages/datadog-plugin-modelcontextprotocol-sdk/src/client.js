'use strict'

const OutboundPlugin = require('../../dd-trace/src/plugins/outbound')

class BaseModelcontextprotocolSdkClientPlugin extends OutboundPlugin {
  static id = 'modelcontextprotocol-sdk'
  static operation = 'request'
  static system = 'modelcontextprotocol-sdk'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_connect'
  static spanName = 'modelcontextprotocol-sdk.connect'

  // Define precursor tags for peer service computation
  // mcp.server.name is the primary source for peer service in MCP SDK
  static peerServicePrecursors = ['mcp.server.name']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan(this.constructor.spanName, {
      meta
    }, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    const tags = {
      component: 'modelcontextprotocol-sdk',
      'span.kind': 'client'
    }

    // Extract server info from the client instance for peer service
    // The MCP SDK Client stores server info in _serverVersion after the connect handshake
    const client = ctx.self
    if (client) {
      // Try getServerVersion() method first (public API), then private _serverVersion property
      let serverVersion
      if (typeof client.getServerVersion === 'function') {
        serverVersion = client.getServerVersion()
      } else if (client._serverVersion) {
        serverVersion = client._serverVersion
      }

      if (serverVersion?.name) {
        tags['mcp.server.name'] = serverVersion.name
      }
    }

    return tags
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (span) {
      // Ensure peer service is computed before finishing the span
      this.tagPeerService(span)
      span.finish()
    }
  }
}

class ClientClosePlugin extends BaseModelcontextprotocolSdkClientPlugin {
  static id = 'mcp_client_close'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_close'
  static spanName = 'modelcontextprotocol-sdk.close'
}

class ClientCallToolPlugin extends BaseModelcontextprotocolSdkClientPlugin {
  static id = 'mcp_client_callTool'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'
  static spanName = 'modelcontextprotocol-sdk.callTool'
}

class ClientListToolsPlugin extends BaseModelcontextprotocolSdkClientPlugin {
  static id = 'mcp_client_listTools'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listTools'
  static spanName = 'modelcontextprotocol-sdk.listTools'
}

class ClientListResourcesPlugin extends BaseModelcontextprotocolSdkClientPlugin {
  static id = 'mcp_client_listResources'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listResources'
  static spanName = 'modelcontextprotocol-sdk.listResources'
}

class ClientReadResourcePlugin extends BaseModelcontextprotocolSdkClientPlugin {
  static id = 'mcp_client_readResource'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_readResource'
  static spanName = 'modelcontextprotocol-sdk.readResource'
}

module.exports = {
  ClientClosePlugin,
  ClientCallToolPlugin,
  ClientListToolsPlugin,
  ClientListResourcesPlugin,
  ClientReadResourcePlugin
}
