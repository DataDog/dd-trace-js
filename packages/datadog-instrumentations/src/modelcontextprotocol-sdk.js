'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/sdk')) {
  addHook(hook, exports => exports)
}

const serverRequestStartCh = channel('apm:mcp:server:request:start')
const serverRequestFinishCh = channel('apm:mcp:server:request:finish')

const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//

const serverToolRegisteredCh = channel('apm:mcp:server:tool:registered')

// Maps Protocol instance → Map<requestId, ctx>. Shares the ctx object between
// _onrequest (span start, in the correct HTTP async context) and setRequestHandler
// wrapper (span finish, after the async handler completes).
const pendingContexts = new WeakMap()

function wrapProtocol (Protocol) {
  // Start spans in _onrequest — this runs inside the express POST /mcp handler's
  // async context, so ALS correctly parents server spans under the HTTP span.
  shimmer.wrap(Protocol.prototype, '_onrequest', function (original) {
    return function _onrequestWithTrace (request, extra) {
      if (!serverRequestStartCh.hasSubscribers || !TRACED_METHOD_PREFIX.test(request.method)) {
        return original.call(this, request, extra)
      }

      const ctx = { request, extra }
      serverRequestStartCh.runStores(ctx, () => {
        if (!pendingContexts.has(this)) pendingContexts.set(this, new Map())
        pendingContexts.get(this).set(request.id, ctx)

        original.call(this, request, extra)

        // MethodNotFound: _onrequest returns without calling a handler — finish immediately.
        const hasHandler = this._requestHandlers?.has(request.method) || !!this.fallbackRequestHandler
        if (!hasHandler) {
          pendingContexts.get(this)?.delete(request.id)
          serverRequestFinishCh.publish(ctx)
        }
      })
    }
  })

  // The SDK's handler closure Zod-parses the request, stripping the JSON-RPC `id`.
  // Use `extra.requestId` (the SDK's fullExtra field) to correlate with the pending ctx.
  shimmer.wrap(Protocol.prototype, 'setRequestHandler', function (original) {
    return function (schema, handler) {
      const protocol = this
      const wrappedHandler = async (request, extra) => {
        const pending = pendingContexts.get(protocol)
        const ctx = pending?.get(extra?.requestId)

        if (!ctx) return handler(request, extra)

        try {
          const result = await handler(request, extra)
          ctx.result = result
          return result
        } catch (err) {
          ctx.error = err
          throw err
        } finally {
          pending.delete(extra?.requestId)
          serverRequestFinishCh.publish(ctx)
        }
      }

      return original.call(this, schema, wrappedHandler)
    }
  })

  return Protocol
}

function wrapMcpServer (McpServer) {
  // Both public registration methods (tool/registerTool) delegate here — one hook covers both.
  shimmer.wrap(McpServer.prototype, '_createRegisteredTool', function (original) {
    return function (name) {
      const result = original.apply(this, arguments)
      if (serverToolRegisteredCh.hasSubscribers) {
        const tool = this._registeredTools?.[name]
        if (tool) serverToolRegisteredCh.publish({ tool, name })
      }
      return result
    }
  })

  return McpServer
}

addHook({
  name: '@modelcontextprotocol/sdk',
  versions: ['>=1.27.1'],
  file: 'dist/cjs/shared/protocol.js',
}, exports => {
  wrapProtocol(exports.Protocol)
  return exports
})

addHook({
  name: '@modelcontextprotocol/sdk',
  versions: ['>=1.27.1'],
  file: 'dist/esm/shared/protocol.js',
}, exports => {
  wrapProtocol(exports.Protocol)
  return exports
})

addHook({
  name: '@modelcontextprotocol/sdk',
  versions: ['>=1.27.1'],
  file: 'dist/cjs/server/mcp.js',
}, exports => {
  wrapMcpServer(exports.McpServer)
  return exports
})

addHook({
  name: '@modelcontextprotocol/sdk',
  versions: ['>=1.27.1'],
  file: 'dist/esm/server/mcp.js',
}, exports => {
  wrapMcpServer(exports.McpServer)
  return exports
})
