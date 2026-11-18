'use strict'

const { beforeEach, describe } = require('mocha')

const { itChecksAgentsMcpToolCalls, itReportsAgentsMcpServerName, useMcpApp } = require('./mcp-helpers')

// A separate sandbox, because @openai/agents 0.21.0 uses the MCP v2 client and openai 7.
describe('AIGuard MCP tool calls of @openai/agents 0.21.0, which uses MCP v2', () => {
  const harness = useMcpApp([
    'express',
    '@modelcontextprotocol/sdk@1.32.2',
    '@modelcontextprotocol/client@2.4.0',
    '@modelcontextprotocol/server@2.4.0',
    'openai@7',
    '@openai/agents@0.21.0',
    'zod',
  ])

  beforeEach(harness.startApp)

  // This version gives the model a fixed text for a tool error, without the error.
  const blockedToolOutput = 'An error occurred while running the tool. Please try again.'
  itChecksAgentsMcpToolCalls(harness, { stdio: blockedToolOutput, streamable_http: blockedToolOutput })
})

// The rewriter targets of the MCP server classes have no upper version bound. Without a version, the
// sandbox installs the latest version of packages/dd-trace/test/plugins/versions/package.json, and
// Dependabot updates that version. Thus a release that moves or renames dist/mcp.js or the methods
// fails this test in the pull request of the update.
describe('AIGuard MCP tool calls of the latest @openai/agents', () => {
  const harness = useMcpApp([
    'express',
    '@modelcontextprotocol/sdk@1.32.2',
    '@modelcontextprotocol/client@2.4.0',
    '@modelcontextprotocol/server@2.4.0',
    'openai',
    '@openai/agents',
    'zod',
  ])

  beforeEach(harness.startApp)

  itReportsAgentsMcpServerName(harness)
})
