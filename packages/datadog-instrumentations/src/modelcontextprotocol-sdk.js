'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/sdk')) {
  addHook(hook, exports => exports)
}

const serverRequestCh = tracingChannel('apm:mcp:server:request')
const clientRequestInjectCh = channel('apm:mcp:client:request:inject')
const serverToolRegisteredCh = channel('apm:mcp:server:tool:registered')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'
const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//

// Maps Protocol instance → Map<requestId, ctx>. Shares the ctx object between
// _onrequest (span start, in the correct HTTP async context), the SDK request
// handler wrapper (result/error capture), and the SDK cleanup path (span finish).
const pendingContexts = new WeakMap()
const wrappedAbortControllerMaps = new WeakSet()
const wrappedRequestHandlerMaps = new WeakSet()
const wrappedRequestHandlers = new WeakSet()

function addTraceContextToRequest (request, traceContext) {
  return {
    ...request,
    params: {
      ...request.params,
      _meta: {
        ...request.params?._meta,
        [DISTRIBUTED_TRACE_META_KEY]: traceContext,
      },
    },
  }
}

function getPendingContext (protocol, requestId) {
  return pendingContexts.get(protocol)?.get(requestId)
}

function finishServerRequest (protocol, requestId) {
  const pending = pendingContexts.get(protocol)
  const ctx = pending?.get(requestId)
  if (!ctx) return

  pending.delete(requestId)
  serverRequestCh.asyncEnd.publish(ctx)
}

function wrapRequestHandler (protocol, handler) {
  if (wrappedRequestHandlers.has(handler)) return handler

  const wrappedHandler = function requestHandlerWithTrace (request, extra) {
    const ctx = getPendingContext(protocol, extra?.requestId)
    if (!ctx) return handler.apply(this, arguments)

    let result
    try {
      result = handler.apply(this, arguments)
    } catch (err) {
      ctx.error = err
      throw err
    }

    return Promise.resolve(result).then(result => {
      ctx.result = result
      return result
    }, err => {
      ctx.error = err
      throw err
    })
  }

  wrappedRequestHandlers.add(wrappedHandler)
  return wrappedHandler
}

function wrapRequestHandlers (protocol) {
  const handlers = protocol._requestHandlers
  if (!handlers || wrappedRequestHandlerMaps.has(handlers)) return

  wrappedRequestHandlerMaps.add(handlers)
  shimmer.wrap(handlers, 'set', function (original) {
    return function setRequestHandlerWithTrace (method, handler) {
      if (typeof handler === 'function') {
        return original.call(this, method, wrapRequestHandler(protocol, handler))
      }

      return original.apply(this, arguments)
    }
  })
}

function wrapAbortControllers (protocol) {
  const controllers = protocol._requestHandlerAbortControllers
  if (!controllers || wrappedAbortControllerMaps.has(controllers)) return

  wrappedAbortControllerMaps.add(controllers)
  shimmer.wrap(controllers, 'delete', function (original) {
    return function deleteAbortControllerWithTrace (requestId) {
      finishServerRequest(protocol, requestId)
      return original.apply(this, arguments)
    }
  })
  shimmer.wrap(controllers, 'clear', function (original) {
    return function clearAbortControllersWithTrace () {
      for (const requestId of this.keys()) {
        finishServerRequest(protocol, requestId)
      }
      return original.apply(this, arguments)
    }
  })
}

function wrapProtocol (Protocol) {
  // Inject trace context into MCP request metadata so out-of-process MCP servers
  // can parent server spans to the client operation span.
  shimmer.wrap(Protocol.prototype, 'request', function (original) {
    return function requestWithTraceContext (request, resultSchema, options) {
      if (!clientRequestInjectCh.hasSubscribers || !TRACED_METHOD_PREFIX.test(request?.method)) {
        return original.apply(this, arguments)
      }

      const ctx = {}
      clientRequestInjectCh.publish(ctx)

      if (!ctx.traceContext) {
        return original.apply(this, arguments)
      }

      return original.call(this, addTraceContextToRequest(request, ctx.traceContext), resultSchema, options)
    }
  })

  // Start spans in _onrequest — this runs inside the express POST /mcp handler's
  // async context, so ALS correctly parents server spans under the HTTP span.
  shimmer.wrap(Protocol.prototype, '_onrequest', function (original) {
    return function _onrequestWithTrace (request, extra) {
      if (!serverRequestCh.hasSubscribers || !TRACED_METHOD_PREFIX.test(request.method)) {
        return original.call(this, request, extra)
      }

      wrapAbortControllers(this)
      const ctx = { request, extra }
      serverRequestCh.start.runStores(ctx, () => {
        let pending = pendingContexts.get(this)
        if (!pending) {
          pending = new Map()
          pendingContexts.set(this, pending)
        }
        pending.set(request.id, ctx)

        try {
          original.call(this, request, extra)
        } catch (err) {
          ctx.error = err
          finishServerRequest(this, request.id)
          throw err
        }

        // The SDK registers an AbortController only when it actually dispatches a handler.
        // If none was registered (MethodNotFound path), no handler will run and our
        // SDK cleanup hook will never fire — finish the span immediately.
        if (!this._requestHandlerAbortControllers?.has(request.id)) {
          finishServerRequest(this, request.id)
        }
      })
    }
  })

  // The SDK's handler closure Zod-parses the request, stripping the JSON-RPC `id`.
  // Use `extra.requestId` (the SDK's fullExtra field) to correlate with the pending ctx.
  shimmer.wrap(Protocol.prototype, 'setRequestHandler', function (original) {
    return function setRequestHandlerWithTrace () {
      wrapRequestHandlers(this)
      return original.apply(this, arguments)
    }
  })

  return Protocol
}

function wrapMcpServer (McpServer) {
  // Both public registration methods (tool/registerTool) delegate here — one hook covers both.
  // Publishes to serverToolRegisteredCh so tracing.js can build a WeakMap of tool → name
  // for O(1) lookup in McpServerToolCallPlugin (executeToolHandler receives the tool object,
  // not the name string).
  shimmer.wrap(McpServer.prototype, '_createRegisteredTool', function (original) {
    return function (name) {
      const result = original.apply(this, arguments)
      if (serverToolRegisteredCh.hasSubscribers) {
        const tool = this._registeredTools?.[name]
        if (tool) {
          serverToolRegisteredCh.publish({ tool, name })
          shimmer.wrap(tool, 'update', function (update) {
            return function updateWithTrace (updates) {
              const result = update.apply(this, arguments)
              if (Object.hasOwn(updates ?? {}, 'name')) {
                serverToolRegisteredCh.publish({ tool, name: updates.name || undefined })
              }
              return result
            }
          })
        }
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
