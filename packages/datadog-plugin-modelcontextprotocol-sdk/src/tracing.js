'use strict'

const { channel } = require('dc-polyfill')
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

function tagRequestParams (span, request) {
  const params = request?.params
  if (!params) return
  if (params.name) {
    span.setTag(request.method === 'prompts/get' ? 'mcp.prompt.name' : 'mcp.tool.name', params.name)
  }
  if (params.uri) span.setTag('mcp.resource.uri', params.uri)
  if (params.arguments) {
    const argumentKeys = Object.keys(params.arguments)
    if (argumentKeys.length) {
      span.setTag('mcp.request.argument_count', argumentKeys.length)
      span.setTag('mcp.request.argument_keys', argumentKeys.join(','))
    }
  }
}

function tagRequestResult (span, result) {
  if (!result) return
  if (result.tools) span.setTag('mcp.tool.names', result.tools.map(t => t.name).join(','))
  if (result.resources) span.setTag('mcp.resource.uris', result.resources.map(r => r.uri).join(','))
  if (result.prompts) {
    span.setTag('mcp.prompt.names', result.prompts.map(p => p.name).join(','))
    const descriptions = result.prompts.map(p => p.description).filter(Boolean)
    if (descriptions.length) span.setTag('mcp.prompt.descriptions', descriptions.join(','))
  }
  if (Array.isArray(result.content)) {
    span.setTag('mcp.tool.response.content_count', result.content.length)

    const contentTypes = []
    for (const item of result.content) {
      if (item.type) contentTypes.push(item.type)
    }

    if (contentTypes.length) span.setTag('mcp.tool.response.content_types', contentTypes.join(','))
  }
}

class McpPlugin extends TracingPlugin {
  bindStart (ctx) {
    this.startSpan(this.constructor.spanName, {
      resource: this.getResource(ctx),
      type: 'mcp',
      kind: this.constructor.kind,
    }, ctx)
    const span = ctx.currentStore?.span
    if (span) this.onStart(span, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (span) this.onEnd(span, ctx)
    super.finish(ctx)
  }

  getResource () {}
  onStart () {}
  onEnd () {}
}

class McpToolCallPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_client'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'
  static spanName = 'mcp.client.tool.call'
  static kind = 'client'
  getResource (ctx) { return ctx.arguments?.[0]?.name }
  onEnd (span, ctx) { setIsErrorTag(ctx) }
}

class McpListToolsPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_list_tools'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listTools'
  static spanName = 'mcp.tools.list'
  static kind = 'client'
  getResource () { return 'tools/list' }
}

class McpListResourcesPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_list_resources'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listResources'
  static spanName = 'mcp.resources.list'
  static kind = 'client'
  getResource () { return 'resources/list' }
}

class McpReadResourcePlugin extends McpPlugin {
  static id = 'modelcontextprotocol_read_resource'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_readResource'
  static spanName = 'mcp.resource.read'
  static kind = 'client'
  getResource (ctx) { return ctx.arguments?.[0]?.uri }
}

class McpListPromptsPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_list_prompts'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listPrompts'
  static spanName = 'mcp.prompts.list'
  static kind = 'client'
  getResource () { return 'prompts/list' }
}

class McpGetPromptPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_get_prompt'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_getPrompt'
  static spanName = 'mcp.prompt.get'
  static kind = 'client'
  getResource (ctx) { return ctx.arguments?.[0]?.name }
}

class McpServerRequestPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_server'
  static prefix = 'tracing:apm:mcp:server:request'
  static spanName = 'mcp.server.request'
  static kind = 'server'
  getResource (ctx) { return ctx.request?.method }
  onStart (span, ctx) { tagRequestParams(span, ctx.request) }
  onEnd (span, ctx) {
    if (ctx.error) span.setTag('error', ctx.error)
    setIsErrorTag(ctx)
    tagRequestResult(span, ctx.result)
  }
}

class McpServerToolCallPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_server_tool'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_executeToolHandler'
  static spanName = 'mcp.server.tool.call'
  static kind = 'internal'
  getResource (ctx) { return toolNames.get(ctx.arguments?.[0]) }
  onEnd (span, ctx) { setIsErrorTag(ctx) }
}

module.exports = [
  McpToolCallPlugin,
  McpListToolsPlugin,
  McpListResourcesPlugin,
  McpReadResourcePlugin,
  McpListPromptsPlugin,
  McpGetPromptPlugin,
  McpServerRequestPlugin,
  McpServerToolCallPlugin,
]
