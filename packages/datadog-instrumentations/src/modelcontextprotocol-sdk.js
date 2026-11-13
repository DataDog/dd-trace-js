'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/sdk').values()) {
  addHook(hook, exports => exports)
}

const serverRequestCh = tracingChannel('apm:mcp:server:request')
const clientRequestInjectCh = channel('apm:mcp:client:request:inject')
const serverToolRegisteredCh = channel('apm:mcp:server:tool:registered')

// Published before Client.callTool sends tools/call, with the client, its transport, the raw
// transport values and the call arguments. A subscriber may set this hook, and this
// instrumentation applies it:
//   beforeCall () => Promise<void>|undefined   the call starts only after the promise fulfils,
//                                               and a rejection cancels the call with that reason
// The original gets ctx.arguments when the call starts. A subscriber may replace ctx.arguments[0],
// for example with a copy of the params that it checked. Then later changes to the params of the
// application cannot reach the server. The channel gets no call of a client without a transport,
// and no call of a tool that the client knows to require task-based execution. The SDK rejects
// both before it sends anything. Other checks of the SDK run after the hook and can still reject a
// published call, for example strict capabilities or a signal that is already aborted.
// MCP v1 (@modelcontextprotocol/sdk) and MCP v2 (@modelcontextprotocol/client) use the same contract.
const callToolInterceptCh = channel('dd-trace:mcp:callTool:intercept')
// Published when Client.listTools resolves, before the caller gets the tools.
const listToolsResultCh = channel('dd-trace:mcp:listTools:result')

const DISTRIBUTED_TRACE_META_KEY = '_dd_trace_context'
const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//
const SDK_VERSIONS = ['>=1.27.1']
const CLIENT_V2_VERSIONS = ['>=2.0.0']

// The client transports by the type that subscribers get. The CommonJS and ESM builds load
// different classes, so each build adds its own entry.
const TRANSPORT_EXPORTS = [
  ['client/stdio.js', 'StdioClientTransport', 'stdio'],
  ['client/sse.js', 'SSEClientTransport', 'sse'],
  ['client/streamableHttp.js', 'StreamableHTTPClientTransport', 'streamable_http'],
  ['client/websocket.js', 'WebSocketClientTransport', 'websocket'],
  ['inMemory.js', 'InMemoryTransport', 'in_process'],
]
// MCP v2 has no WebSocket transport. Its main entry exports the other transports.
const V2_TRANSPORT_EXPORTS = [
  ['SSEClientTransport', 'sse'],
  ['StreamableHTTPClientTransport', 'streamable_http'],
  ['InMemoryTransport', 'in_process'],
]
const transportClasses = new Map()
const transportInfos = new WeakMap()

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

    if (result && typeof result.then === 'function') {
      result.then(result => {
        ctx.result = result
      }, err => {
        ctx.error = err
      })
      return result
    }

    ctx.result = result
    return result
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
      const ctx = { request, extra, server: this }
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
        } finally {
          // runStores restores only the APM store. `end` lets the LLM Obs plugin restore its own store. The handler
          // keeps the server span because the SDK schedules it before `_onrequest` returns.
          serverRequestCh.end.publish(ctx)
        }

        // The SDK registers an AbortController only when it actually dispatches a handler.
        // If none was registered (MethodNotFound path), no handler will run and our
        // SDK cleanup hook will never fire — finish the span immediately.
        if (!this._requestHandlerAbortControllers?.has(request.id)) {
          ctx.error = { name: 'McpError', message: 'Method not found' }
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
              if (updates && Object.hasOwn(updates, 'name')) {
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

/**
 * Reads the raw values that identify the server of a client transport. It reads only the stdio
 * command and arguments, or the URL of a remote transport. It never reads headers, request
 * options, authentication data, environment or working directory.
 *
 * @param {object} transport
 * @returns {{ type: string, command?: unknown, args?: unknown, url?: unknown }}
 */
function describeTransport (transport) {
  try {
    for (const [Transport, type] of transportClasses) {
      if (!(transport instanceof Transport)) continue

      if (type === 'stdio') {
        const params = transport._serverParams
        return { type, command: params?.command, args: params?.args }
      }
      return type === 'in_process' ? { type } : { type, url: transport._url }
    }
  } catch {
    // A transport that cannot be inspected is reported without metadata.
  }
  return { type: 'unknown' }
}

/**
 * @param {unknown} transport
 * @returns {{ type: string, command?: unknown, args?: unknown, url?: unknown }|undefined}
 */
function getTransportInfo (transport) {
  if (transport === null || typeof transport !== 'object') return

  let info = transportInfos.get(transport)
  if (info === undefined) {
    info = describeTransport(transport)
    transportInfos.set(transport, info)
  }
  return info
}

/**
 * @typedef {object} CallToolInterceptContext
 * @property {object} client
 * @property {unknown} transport
 * @property {ReturnType<typeof getTransportInfo>} transportInfo
 * @property {IArguments} arguments
 * @property {() => Promise<unknown>|undefined} [beforeCall]
 */

/**
 * Runs the hook that a subscriber installed. A failure of the hook itself lets the call run.
 *
 * @param {CallToolInterceptContext} ctx
 * @returns {Promise<unknown>|undefined}
 */
function startBeforeCall (ctx) {
  if (typeof ctx.beforeCall !== 'function') return

  let pending
  try {
    pending = ctx.beforeCall()
  } catch {
    // The hook must not break the call.
    return
  }
  return typeof pending?.then === 'function' ? pending : undefined
}

/**
 * Returns whether the SDK rejects the call because the tool requires task-based execution.
 *
 * @param {{ isToolTaskRequired?: (name: unknown) => unknown }} client
 * @param {unknown} params
 */
function isTaskRequired (client, params) {
  try {
    const name = /** @type {{ name?: unknown }|undefined} */ (params)?.name
    return typeof client.isToolTaskRequired === 'function' && client.isToolTaskRequired(name) === true
  } catch {
    return false
  }
}

// Shimmer, not Orchestrion: the call must wait for an asynchronous check before tools/call is sent,
// and a rejected check must cancel it. Subscribers of the Orchestrion channels cannot hold the call.
/**
 * @param {Function} callTool
 */
function wrapCallTool (callTool) {
  return function callToolWithIntercept () {
    if (!callToolInterceptCh.hasSubscribers) return callTool.apply(this, arguments)

    const transport = this?.transport
    // The SDK rejects these calls with its own error before it sends anything.
    if (!transport || isTaskRequired(this, arguments[0])) return callTool.apply(this, arguments)

    /** @type {CallToolInterceptContext} */
    const ctx = { client: this, transport, transportInfo: getTransportInfo(transport), arguments }
    callToolInterceptCh.publish(ctx)

    const pending = startBeforeCall(ctx)
    const args = ctx.arguments
    if (!pending) return callTool.apply(this, args)

    return pending.then(() => callTool.apply(this, args))
  }
}

// Shimmer, not Orchestrion: the transport values must come from this file. To read them on the
// Orchestrion channel of Client_listTools, this file must subscribe to that channel itself. That
// subscriber keeps the channel active in every process, also when no subscriber listens to
// listToolsResultCh. With no subscriber, this wrapper only checks hasSubscribers.
/**
 * @param {Function} listTools
 */
function wrapListTools (listTools) {
  return function listToolsWithResult () {
    const result = listTools.apply(this, arguments)
    if (!listToolsResultCh.hasSubscribers || typeof result?.then !== 'function') return result

    // The caller gets the tools after the subscribers, so a model request built from them can link to this client.
    return result.then(listed => {
      if (listToolsResultCh.hasSubscribers) {
        const transport = this?.transport
        listToolsResultCh.publish({
          client: this,
          transport,
          transportInfo: getTransportInfo(transport),
          tools: listed?.tools,
        })
      }
      return listed
    })
  }
}

/**
 * @param {Function|undefined} Client
 */
function wrapClient (Client) {
  const prototype = Client?.prototype
  if (typeof prototype?.callTool === 'function') shimmer.wrap(prototype, 'callTool', wrapCallTool)
  if (typeof prototype?.listTools === 'function') shimmer.wrap(prototype, 'listTools', wrapListTools)
  return Client
}

/**
 * @param {unknown} Transport
 * @param {string} type
 */
function captureTransport (Transport, type) {
  if (typeof Transport === 'function') transportClasses.set(Transport, type)
}

for (const build of ['cjs', 'esm']) {
  addHook({
    name: '@modelcontextprotocol/sdk',
    versions: SDK_VERSIONS,
    file: `dist/${build}/client/index.js`,
  }, exports => {
    wrapClient(/** @type {{ Client?: Function }} */ (exports).Client)
    return exports
  })

  for (const [file, exportName, type] of TRANSPORT_EXPORTS) {
    addHook({ name: '@modelcontextprotocol/sdk', versions: SDK_VERSIONS, file: `dist/${build}/${file}` }, exports => {
      captureTransport(/** @type {Record<string, unknown>} */ (exports)[exportName], type)
      return exports
    })
  }
}

// MCP v2 is a bundle, and the names of its chunk files change between releases. The hooks use the
// entry files of the package exports, which re-export the classes of the chunks. The require hook
// gives the main CommonJS entry the package name, so that hook has no file.
for (const file of [undefined, 'dist/index.mjs']) {
  addHook({ name: '@modelcontextprotocol/client', versions: CLIENT_V2_VERSIONS, file }, exports => {
    const moduleExports = /** @type {Record<string, unknown>} */ (exports)
    wrapClient(/** @type {Function|undefined} */ (moduleExports.Client))
    for (const [exportName, type] of V2_TRANSPORT_EXPORTS) {
      captureTransport(moduleExports[exportName], type)
    }
    return exports
  })
}

for (const file of ['dist/stdio.cjs', 'dist/stdio.mjs']) {
  addHook({ name: '@modelcontextprotocol/client', versions: CLIENT_V2_VERSIONS, file }, exports => {
    captureTransport(/** @type {Record<string, unknown>} */ (exports).StdioClientTransport, 'stdio')
    return exports
  })
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
