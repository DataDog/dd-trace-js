'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class McpClientCallToolPlugin extends ClientPlugin {
  static id = 'mcp-client'
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_callTool'
  static spanName = 'mcp-client.callTool'
  static peerServicePrecursors = ['mcp.server.name']

  bindStart (ctx) {
    const params = ctx.arguments?.[0]
    const resource = this.getResource(params)
    const meta = this.getTags(params)

    const serverName = this._getServerName(ctx)
    if (serverName) {
      meta['mcp.server.name'] = serverName
    }

    const span = this.startSpan(this.constructor.spanName, {
      service: this.config.service,
      resource,
      kind: 'client',
      meta,
    }, ctx)

    this._injectContext(span, ctx)

    return ctx.currentStore
  }

  /**
   * Extracts the MCP server name from the underlying SDK client.
   * After connect(), the SDK Client stores server info including name and version.
   *
   * @param {object} ctx
   * @returns {string|undefined}
   */
  _getServerName (ctx) {
    return ctx.self?.client?.getServerVersion?.()?.name
  }

  /**
   * Injects distributed trace context into the MCP request params._meta._datadog field.
   * This allows instrumented MCP servers to extract and continue the trace.
   *
   * @param {import('../../../../..').Span} span
   * @param {object} ctx
   */
  _injectContext (span, ctx) {
    const params = ctx.arguments?.[0]
    if (!params || typeof params !== 'object') return

    params._meta ??= {}
    params._meta._datadog ??= {}
    this.tracer.inject(span, 'text_map', params._meta._datadog)
  }

  getResource (params) {
    return params?.name
  }

  getTags (params) {
    const tags = {
      component: 'mcp-client',
      'span.kind': 'client',
    }
    if (params?.name) {
      tags['mcp.tool.name'] = params.name
    }
    return tags
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }
}

class McpClientGetResourcePlugin extends McpClientCallToolPlugin {
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_getResource'
  static spanName = 'mcp-client.getResource'

  getResource (params) {
    return params?.uri
  }

  getTags (params) {
    const tags = {
      component: 'mcp-client',
      'span.kind': 'client',
    }
    if (params?.uri) {
      tags['mcp.resource.uri'] = params.uri
    }
    return tags
  }
}

class McpClientGetPromptPlugin extends McpClientCallToolPlugin {
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_getPrompt'
  static spanName = 'mcp-client.getPrompt'

  getResource (params) {
    return params?.name
  }

  getTags (params) {
    const tags = {
      component: 'mcp-client',
      'span.kind': 'client',
    }
    if (params?.name) {
      tags['mcp.prompt.name'] = params.name
    }
    return tags
  }
}

class McpClientCompletePlugin extends McpClientCallToolPlugin {
  static prefix = 'tracing:orchestrion:mcp-client:MCPClient_complete'
  static spanName = 'mcp-client.complete'

  getResource (params) {
    return params?.ref?.name
  }

  getTags (params) {
    const tags = {
      component: 'mcp-client',
      'span.kind': 'client',
    }
    if (params?.ref?.type) {
      tags['mcp.completion.ref'] = params.ref.type
    }
    if (params?.ref?.name) {
      tags['mcp.completion.name'] = params.ref.name
    }
    return tags
  }
}

module.exports = {
  McpClientCallToolPlugin,
  McpClientGetResourcePlugin,
  McpClientGetPromptPlugin,
  McpClientCompletePlugin,
}
