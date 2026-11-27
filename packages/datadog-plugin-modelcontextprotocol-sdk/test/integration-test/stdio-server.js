'use strict'

const tracer = require('../../../..').init({ flushInterval: 0 })
const versionMod = require(`../../../../versions/@modelcontextprotocol/sdk@${process.argv[2]}`)
const { McpServer } = versionMod.get('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = versionMod.get('@modelcontextprotocol/sdk/server/stdio.js')

const server = new McpServer({ name: 'node-peer', version: '1.0.0' })
server.registerTool('trace-context', { inputSchema: {} }, async (args, extra) => {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        trace_id: tracer.scope().active()?.context().toTraceparent().split('-')[1],
        headers: extra._meta?._dd_trace_context,
      }),
    }],
  }
})

server.connect(new StdioServerTransport()).catch(error => {
  process.stderr.write(error.stack)
  process.exitCode = 1
})
