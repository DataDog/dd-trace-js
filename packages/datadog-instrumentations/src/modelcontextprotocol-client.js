'use strict'

const { channel, tracingChannel } = require('dc-polyfill')

const { addTraceContextToRequest } = require('./modelcontextprotocol-sdk')

const requestCh = tracingChannel('orchestrion:@modelcontextprotocol/client:Protocol_request')
const clientRequestInjectCh = channel('apm:mcp:client:request:inject')

const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//

// Replacing the request argument before Protocol.request runs puts the trace context in `_meta`, so out-of-process MCP
// servers can parent their spans to the client span.
requestCh.start.subscribe(ctx => {
  const request = ctx.arguments?.[0]
  if (!clientRequestInjectCh.hasSubscribers || !TRACED_METHOD_PREFIX.test(request?.method)) return

  const injectCtx = {}
  clientRequestInjectCh.publish(injectCtx)
  if (injectCtx.traceContext) ctx.arguments[0] = addTraceContextToRequest(request, injectCtx.traceContext)
})
