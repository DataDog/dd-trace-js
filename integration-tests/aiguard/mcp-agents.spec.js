'use strict'

const { beforeEach, describe } = require('mocha')

const { itChecksAgentsMcpToolCalls, useMcpApp } = require('./mcp-helpers')

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
