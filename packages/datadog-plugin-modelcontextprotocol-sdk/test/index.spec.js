'use strict'

const assert = require('node:assert/strict')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', {
  subModule: '@modelcontextprotocol/sdk/client',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod, meta.versionMod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Client.callTool() - mcp.client.tool.call', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.client.tool.call',
        type: 'mcp',
        resource: 'test-tool',
        meta: {
          component: 'modelcontextprotocol_client',
          '_dd.integration': 'modelcontextprotocol_client',
          'span.kind': 'client',
        },
      })

      const result = await testSetup.clientCallTool()
      assert.ok(result.content, 'callTool should return a result with content')
      assert.equal(result.content.length, 1)
      assert.equal(result.content[0].type, 'text')
      assert.equal(result.content[0].text, 'Result from test-tool')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.client.tool.call',
        type: 'mcp',
        resource: 'error-tool',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_client',
          '_dd.integration': 'modelcontextprotocol_client',
          'span.kind': 'client',
        },
      })

      // In MCP SDK 1.27+, tool errors are returned as isError:true results, not thrown exceptions
      const result = await testSetup.clientCallToolError()
      assert.ok(result.isError, 'callTool result should have isError: true')
      assert.ok(result.content?.[0]?.text?.includes('Intentional test error'), 'error text should be in content')

      return traceAssertion
    })
  })

  describe('Client.listTools() - mcp.tools.list', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.tools.list',
        type: 'mcp',
        resource: 'tools/list',
        meta: {
          component: 'modelcontextprotocol_list_tools',
          '_dd.integration': 'modelcontextprotocol_list_tools',
          'span.kind': 'client',
        },
      })

      const result = await testSetup.clientListTools()
      assert.ok(result.tools, 'listTools should return tools array')
      assert.equal(result.tools.length, 2)

      return traceAssertion
    })
  })

  describe('Client.connect() - mcp.connect', () => {
    it('should generate span with correct tags', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.connect',
        type: 'mcp',
        resource: 'connect',
        meta: {
          component: 'modelcontextprotocol_connect',
          '_dd.integration': 'modelcontextprotocol_connect',
          'span.kind': 'client',
        },
      })

      await testSetup.clientReconnect()

      return traceAssertion
    })
  })
})
