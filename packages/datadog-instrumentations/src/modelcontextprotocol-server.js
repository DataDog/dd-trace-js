'use strict'

const { channel, tracingChannel } = require('dc-polyfill')

const shimmer = require('../../datadog-shimmer')

const wrapHandlerCh = tracingChannel('orchestrion:@modelcontextprotocol/server:Server__wrapHandler')
const registerToolCh = tracingChannel('orchestrion:@modelcontextprotocol/server:McpServer_registerTool')
const serverRequestCh = tracingChannel('apm:mcp:server:request')
const serverToolRegisteredCh = channel('apm:mcp:server:tool:registered')

const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//

// The SDK builds each request handler at runtime, so the handler that Server._wrapHandler returns is replaced to trace
// every call. The SDK runs it in the async context of the incoming request.
wrapHandlerCh.end.subscribe(ctx => {
  const handler = ctx.result
  if (typeof handler !== 'function' || !TRACED_METHOD_PREFIX.test(ctx.arguments?.[0])) return

  const server = ctx.self
  ctx.result = shimmer.wrapFunction(handler, handler => function tracedRequestHandler (request, extra) {
    if (!serverRequestCh.hasSubscribers) return handler.apply(this, arguments)

    return serverRequestCh.tracePromise(handler, { request, extra, server }, this, ...arguments)
  })
})

// Tool objects are created at runtime, so their `update` method is wrapped to follow renames.
registerToolCh.end.subscribe(ctx => {
  const tool = ctx.result
  if (!tool || !serverToolRegisteredCh.hasSubscribers) return

  serverToolRegisteredCh.publish({ tool, name: ctx.arguments[0] })
  shimmer.wrap(tool, 'update', update => function updateWithTrace (updates) {
    const result = update.apply(this, arguments)
    if (updates && Object.hasOwn(updates, 'name')) {
      serverToolRegisteredCh.publish({ tool, name: updates.name || undefined })
    }
    return result
  })
})
