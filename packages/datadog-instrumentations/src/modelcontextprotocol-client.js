'use strict'

const { channel, tracingChannel } = require('dc-polyfill')

const { addHook } = require('./helpers/instrument')
const { addTraceContextToRequest, captureTransport, wrapClient } = require('./modelcontextprotocol-sdk')

const requestCh = tracingChannel('orchestrion:@modelcontextprotocol/client:Protocol_request')
const clientRequestInjectCh = channel('apm:mcp:client:request:inject')

const TRACED_METHOD_PREFIX = /^(?:tools|resources|prompts)\//
const CLIENT_VERSIONS = ['>=2.0.0']
// MCP v2 has no WebSocket transport. Its main entry exports the other transports.
const TRANSPORT_EXPORTS = [
  ['SSEClientTransport', 'sse'],
  ['StreamableHTTPClientTransport', 'streamable_http'],
  ['InMemoryTransport', 'in_process'],
]

// Replacing the request argument before Protocol.request runs puts the trace context in `_meta`, so out-of-process MCP
// servers can parent their spans to the client span.
requestCh.start.subscribe(ctx => {
  const request = ctx.arguments?.[0]
  if (!clientRequestInjectCh.hasSubscribers || !TRACED_METHOD_PREFIX.test(request?.method)) return

  const injectCtx = {}
  clientRequestInjectCh.publish(injectCtx)
  if (injectCtx.traceContext) ctx.arguments[0] = addTraceContextToRequest(request, injectCtx.traceContext)
})

// The AI Guard check of MCP v2 uses the same shimmer wrappers as MCP v1. The names of the chunk
// files of the bundle change between releases, so these hooks use the entry files of the package
// exports, which export the classes of the chunks. The require hook gives the main CommonJS entry
// the package name, so that hook has no file.
// These hooks are in this file and not in modelcontextprotocol-sdk.js. Thus the test setup gets the
// MCP v2 versions of the modelcontextprotocol-sdk plugin only from externals.js, which installs them
// only on the Node.js versions that MCP v2 supports.
for (const file of [undefined, 'dist/index.mjs']) {
  addHook({ name: '@modelcontextprotocol/client', versions: CLIENT_VERSIONS, file }, exports => {
    const moduleExports = /** @type {Record<string, unknown>} */ (exports)
    wrapClient(/** @type {Function|undefined} */ (moduleExports.Client))
    for (const [exportName, type] of TRANSPORT_EXPORTS) {
      captureTransport(moduleExports[exportName], type)
    }
    return exports
  })
}

for (const file of ['dist/stdio.cjs', 'dist/stdio.mjs']) {
  addHook({ name: '@modelcontextprotocol/client', versions: CLIENT_VERSIONS, file }, exports => {
    captureTransport(/** @type {Record<string, unknown>} */ (exports).StdioClientTransport, 'stdio')
    return exports
  })
}
