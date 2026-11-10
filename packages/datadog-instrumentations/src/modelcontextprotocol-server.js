'use strict'

// MCP TypeScript SDK 2.x server (`@modelcontextprotocol/server`). Orchestrion rewrites the SDK's bundled chunks (see
// rewriter/instrumentations/modelcontextprotocol-server.js); this file keeps the per-request state those hooks share.

const { tracingChannel } = require('dc-polyfill')
const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/server').values()) {
  addHook(hook, exports => exports)
}

const requestCh = tracingChannel('orchestrion:@modelcontextprotocol/server:Protocol__onrequest')
const wrapHandlerCh = tracingChannel('orchestrion:@modelcontextprotocol/server:Server__wrapHandler')
const closeCh = tracingChannel('orchestrion:@modelcontextprotocol/server:Protocol__onclose')

const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//

// Protocol instance → Map<requestId, ctx> for server requests whose span is still open.
const pendingRequests = new WeakMap()

/**
 * @param {object} protocol
 * @param {string|number} requestId
 */
function finishRequest (protocol, requestId) {
  const pending = pendingRequests.get(protocol)
  const ctx = pending?.get(requestId)
  if (!ctx) return

  pending.delete(requestId)
  // `_onrequest` returns before its handler runs, so Orchestrion never publishes `asyncEnd` for it. Publishing it when
  // the request settles lets the plugins finish the span on their usual completion event.
  requestCh.asyncEnd.publish(ctx)
}

requestCh.start.subscribe(ctx => {
  const request = ctx.arguments?.[0]
  if (!TRACED_METHOD_PREFIX.test(request?.method)) return

  let pending = pendingRequests.get(ctx.self)
  if (!pending) {
    pending = new Map()
    pendingRequests.set(ctx.self, pending)
  }
  pending.set(request.id, ctx)
})

requestCh.end.subscribe(ctx => {
  const request = ctx.arguments?.[0]
  if (!pendingRequests.get(ctx.self)?.has(request?.id)) return

  // The SDK registers an abort controller only when it dispatches a handler. Without one it already answered with an
  // error, such as method not found, and no handler will settle.
  if (ctx.error || !ctx.self._requestHandlerAbortControllers?.has(request.id)) {
    ctx.error ??= { name: 'McpError', message: 'Method not found' }
    finishRequest(ctx.self, request.id)
  }
})

// Every handler a server registers passes through Server._wrapHandler, so wrapping its result captures the outcome of
// each request without patching the SDK's per-instance handler and abort controller maps.
wrapHandlerCh.end.subscribe(ctx => {
  const handler = ctx.result
  if (typeof handler !== 'function') return

  const protocol = ctx.self
  ctx.result = function requestHandlerWithTrace (request, handlerContext) {
    const requestId = handlerContext?.mcpReq?.id
    const requestCtx = pendingRequests.get(protocol)?.get(requestId)
    if (!requestCtx) return handler.apply(this, arguments)

    requestCtx.handlerContext = handlerContext

    let result
    try {
      result = handler.apply(this, arguments)
    } catch (error) {
      requestCtx.error = error
      finishRequest(protocol, requestId)
      throw error
    }

    if (typeof result?.then !== 'function') {
      requestCtx.result = result
      finishRequest(protocol, requestId)
      return result
    }

    result.then(value => {
      requestCtx.result = value
      finishRequest(protocol, requestId)
    }, error => {
      requestCtx.error = error
      finishRequest(protocol, requestId)
    })
    return result
  }
})

closeCh.start.subscribe(({ self }) => {
  const pending = pendingRequests.get(self)
  if (!pending) return

  for (const [requestId, ctx] of pending) {
    // The close aborts a handler that has not settled, so the client never gets its response.
    ctx.error ??= { name: 'McpError', message: 'Connection closed' }
    finishRequest(self, requestId)
  }
})
