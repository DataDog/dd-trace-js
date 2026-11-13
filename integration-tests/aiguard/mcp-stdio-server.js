'use strict'

// A stdio MCP server for the AI Guard MCP tests. Its tool appends a line to a file, so a test can
// prove that a blocked call never reaches the tool handler.
const fs = require('node:fs')

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

// The handshake name must never become the reported server name.
const server = new McpServer({ name: 'handshake-name-must-not-be-reported', version: '1.0.0' })

server.registerTool('write_file', {
  description: 'Writes a line',
  inputSchema: { text: z.string() },
}, ({ text }) => {
  fs.appendFileSync(process.env.MCP_SIDE_EFFECT_FILE, `stdio:${text}\n`)
  return { content: [{ type: 'text', text: `wrote ${text}` }] }
})

server.connect(new StdioServerTransport())
