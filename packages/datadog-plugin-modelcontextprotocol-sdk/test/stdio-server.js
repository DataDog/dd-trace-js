'use strict'

// A stdio MCP server that loads the SDK version under test from MCP_SDK_DIR.
const path = require('node:path')

const sdkDir = String(process.env.MCP_SDK_DIR)
const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
const { StdioServerTransport } = require(path.join(sdkDir, 'dist/cjs/server/stdio.js'))
const { z } = require(require.resolve('zod', { paths: [sdkDir] }))

const server = new McpServer({ name: 'stdio-test-server', version: '1.0.0' })
server.registerTool('echo', { description: 'Echoes the text', inputSchema: { text: z.string() } }, ({ text }) => ({
  content: [{ type: 'text', text }],
}))
server.connect(new StdioServerTransport())
