'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', {
  subModule: '@modelcontextprotocol/sdk/client',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Client.callTool() - mcp.tool.call', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.tool.call',
        type: 'llm',
        resource: 'test-tool',
        meta: {
          component: 'modelcontextprotocol_client',
          '_dd.integration': 'modelcontextprotocol_client',
          'span.kind': 'client',
          'ai.operation': 'tool_call',
          'mcp.tool.name': 'test-tool',
          'mcp.tool.arguments': '{}',
          'mcp.operation': 'tools/call',
          'mcp.server.name': 'test-server',
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
        name: 'mcp.tool.call',
        type: 'llm',
        resource: 'error-tool',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_client',
          '_dd.integration': 'modelcontextprotocol_client',
          'span.kind': 'client',
          'ai.operation': 'tool_call',
          'mcp.tool.name': 'error-tool',
          'mcp.tool.arguments': '{}',
          'mcp.operation': 'tools/call',
          'error.type': ANY_STRING,
          'error.message': ANY_STRING,
          'error.stack': ANY_STRING,
        },
      })

      let caughtError
      try {
        await testSetup.clientCallToolError()
      } catch (err) {
        caughtError = err
      }
      assert.ok(caughtError, 'callTool should throw an error')
      assert.ok(caughtError.message.includes('Intentional test error'), 'error message should contain expected text')

      return traceAssertion
    })
  })

  describe('Protocol.request() - mcp.request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'http',
        resource: 'tools/list',
        meta: {
          component: 'modelcontextprotocol_request',
          '_dd.integration': 'modelcontextprotocol_request',
          'span.kind': 'client',
          'rpc.system': 'jsonrpc',
          'rpc.jsonrpc.version': '2.0',
          'mcp.method': 'tools/list',
          'mcp.request.id': ANY_STRING,
          'mcp.server.name': 'test-server',
        },
      })

      const result = await testSetup.protocolRequest()
      assert.ok(result.tools, 'listTools should return tools array')
      assert.equal(result.tools.length, 2)
      assert.equal(result.tools[0].name, 'test-tool')
      assert.equal(result.tools[1].name, 'error-tool')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'http',
        resource: 'nonexistent/method',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_request',
          '_dd.integration': 'modelcontextprotocol_request',
          'span.kind': 'client',
          'rpc.system': 'jsonrpc',
          'rpc.jsonrpc.version': '2.0',
          'mcp.method': 'nonexistent/method',
          'mcp.request.id': ANY_STRING,
          'error.type': ANY_STRING,
          'error.message': ANY_STRING,
          'error.stack': ANY_STRING,
        },
      })

      let caughtError
      try {
        await testSetup.protocolRequestError()
      } catch (err) {
        caughtError = err
      }
      assert.ok(caughtError, 'request should throw an error')
      assert.ok(caughtError.message.length > 0, 'error should have a non-empty message')

      return traceAssertion
    })
  })

  describe('peer service', () => {
    let computePeerServiceStub

    beforeEach(() => {
      const compositePlugin = meta.tracer._pluginManager._pluginsByName['modelcontextprotocol-sdk']
      const subPlugin = compositePlugin.modelcontextprotocol_client
      computePeerServiceStub = sinon.stub(subPlugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    afterEach(() => {
      computePeerServiceStub.restore()
    })

    it('should set peer.service from mcp.server.name on callTool', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.tool.call',
        meta: {
          'mcp.server.name': 'test-server',
          'peer.service': 'test-server',
          '_dd.peer.service.source': 'mcp.server.name',
        },
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should set peer.service from mcp.server.name on Protocol.request', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        meta: {
          'mcp.server.name': 'test-server',
          'peer.service': 'test-server',
          '_dd.peer.service.source': 'mcp.server.name',
        },
      })

      await testSetup.protocolRequest()

      return traceAssertion
    })
  })
})
