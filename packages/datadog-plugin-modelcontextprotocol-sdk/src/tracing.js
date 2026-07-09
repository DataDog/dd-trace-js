'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const {
  DISTRIBUTED_TRACE_META_KEY,
  tagErrorResult,
} = require('./utils')

const MCP_REQUEST_SPAN_NAME = 'mcp.request'
const CLIENT_TOOL_CALL_RESOURCE = 'client_tool_call'
const CLIENT_LIST_TOOLS_RESOURCE = 'ClientSession.list_tools'
const SERVER_TOOL_CALL_RESOURCE = 'server_tool_call'

function getServerRequestResource (request) {
  if (request?.method === 'tools/call') return SERVER_TOOL_CALL_RESOURCE
  return request?.method
}

class McpPlugin extends TracingPlugin {
  bindStart (ctx) {
    const spanOptions = {
      resource: this.getResource(ctx),
      type: 'mcp',
      kind: this.constructor.kind,
    }
    const childOf = this.getChildOf(ctx)
    if (childOf) spanOptions.childOf = childOf

    this.startSpan(this.constructor.spanName, spanOptions, ctx)
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
  getChildOf () {}
  onStart () {}
  onEnd () {}
}

class McpPropagationPlugin extends Plugin {
  static id = 'modelcontextprotocol_propagation'

  constructor (...args) {
    super(...args)
    this.addSub('apm:mcp:client:request:inject', this.injectTraceContext.bind(this))
  }

  injectTraceContext (ctx) {
    const span = this.tracer.scope().active()
    if (!span) return

    const traceContext = {}
    this.tracer.inject(span, 'text_map', traceContext)
    ctx.traceContext = traceContext
  }
}

class McpToolCallPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_client'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_callTool'
  static spanName = MCP_REQUEST_SPAN_NAME
  static kind = 'client'
  getResource () { return CLIENT_TOOL_CALL_RESOURCE }
  onEnd (span, ctx) { tagErrorResult(span, ctx.result) }
}

class McpListToolsPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_list_tools'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:Client_listTools'
  static spanName = MCP_REQUEST_SPAN_NAME
  static kind = 'client'
  getResource () { return CLIENT_LIST_TOOLS_RESOURCE }
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
  static spanName = MCP_REQUEST_SPAN_NAME
  static kind = 'server'
  getResource (ctx) { return getServerRequestResource(ctx.request) }
  getChildOf (ctx) {
    const traceContext = ctx.request?.params?._meta?.[DISTRIBUTED_TRACE_META_KEY]
    if (!traceContext || typeof traceContext !== 'object') return

    const childOf = this.tracer.extract('text_map', traceContext)
    const activeSpan = this.activeSpan
    if (!childOf || activeSpan?.context().toTraceId() === childOf.toTraceId()) return

    return childOf
  }

  onEnd (span, ctx) {
    if (ctx.error) {
      span.setTag('error', ctx.error)
    } else {
      tagErrorResult(span, ctx.result)
    }
  }
}

class McpServerToolCallPlugin extends McpPlugin {
  static id = 'modelcontextprotocol_server_tool'
  static prefix = 'tracing:orchestrion:@modelcontextprotocol/sdk:McpServer_executeToolHandler'
  static spanName = 'mcp.server.tool.call'
  static kind = 'internal'

  /**
   * @param {...unknown} args Plugin constructor arguments.
   */
  constructor (...args) {
    super(...args)
    this.toolNames = new WeakMap()
    this.addSub('apm:mcp:server:tool:registered', ({ tool, name }) => {
      this.toolNames.set(tool, name)
    })
  }

  getResource (ctx) { return this.toolNames.get(ctx.arguments?.[0]) }
  onEnd (span, ctx) { tagErrorResult(span, ctx.result) }
}

module.exports = [
  McpPropagationPlugin,
  McpToolCallPlugin,
  McpListToolsPlugin,
  McpListResourcesPlugin,
  McpReadResourcePlugin,
  McpListPromptsPlugin,
  McpGetPromptPlugin,
  McpServerRequestPlugin,
  McpServerToolCallPlugin,
]
