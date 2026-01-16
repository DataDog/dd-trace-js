'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', {
  category: 'llm',
  subModule: '@modelcontextprotocol/sdk/client'
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  // Note: Client.connect() and Client.close() use 'super' keyword and cannot be
  // instrumented with Orchestrion AST rewriting. Tests for these methods are skipped.

  describe('Client.callTool() - tool.call', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.callTool',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server'
          }
        }
      )

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.callTool',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server',
            'error.type': 'McpError'
          },
          error: 1
        }
      )

      // Execute operation and verify error behavior
      let errorCaught = false
      try {
        await testSetup.clientCallToolError()
      } catch (err) {
        errorCaught = true
        assert.ok(err, 'Expected error to be thrown')
      }
      assert.ok(errorCaught, 'callToolError should throw an error')

      return traceAssertion
    })
  })

  describe('Client.listTools() - tool.list', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.listTools',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server'
          }
        }
      )

      await testSetup.clientListTools()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.listTools',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server',
            'error.type': 'Error',
            'error.message': 'Not connected'
          },
          error: 1
        }
      )

      // Execute operation and verify error behavior
      let errorCaught = false
      try {
        await testSetup.clientListToolsError()
      } catch (err) {
        errorCaught = true
        assert.ok(err, 'Expected error to be thrown')
        assert.strictEqual(err.message, 'Not connected')
      }
      assert.ok(errorCaught, 'clientListToolsError should throw an error')

      return traceAssertion
    })
  })

  describe('Client.listResources() - resource.list', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.listResources',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server'
          }
        }
      )

      await testSetup.clientListResources()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.listResources',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server',
            'error.type': 'Error',
            'error.message': 'Not connected'
          },
          error: 1
        }
      )

      // Execute operation and verify error behavior
      let errorCaught = false
      try {
        await testSetup.clientListResourcesError()
      } catch (err) {
        errorCaught = true
        assert.ok(err, 'Expected error to be thrown')
        assert.strictEqual(err.message, 'Not connected')
      }
      assert.ok(errorCaught, 'clientListResourcesError should throw an error')

      return traceAssertion
    })
  })

  describe('Client.readResource() - resource.read', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.readResource',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server'
          }
        }
      )

      await testSetup.clientReadResource()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'modelcontextprotocol-sdk.readResource',
          meta: {
            'span.kind': 'client',
            component: 'modelcontextprotocol-sdk',
            'mcp.server.name': 'test-server',
            'error.type': 'McpError'
          },
          error: 1
        }
      )

      // Execute operation and verify error behavior
      let errorCaught = false
      try {
        await testSetup.clientReadResourceError()
      } catch (err) {
        errorCaught = true
        assert.ok(err, 'Expected error to be thrown')
      }
      assert.ok(errorCaught, 'clientReadResourceError should throw an error')

      return traceAssertion
    })
  })

  // Note: Protocol.request() is a low-level method that's called internally by Client methods.
  // McpServer methods (connect, close, executeToolHandler) use 'super' keyword and cannot be
  // instrumented with Orchestrion AST rewriting. Tests for these methods are skipped.

  describe('Context Propagation', () => {
    it('should propagate context from parent span to client callTool', async () => {
      // Get tracer by requiring it directly (meta.tracer may be null)
      const ddTracer = require('../../dd-trace')

      const traceAssertion = agent.assertSomeTraces(traces => {
        const callToolSpan = traces.flat().find(s => s.name === 'modelcontextprotocol-sdk.callTool')
        if (!callToolSpan) {
          throw new Error('callTool span not found')
        }

        const parentId = callToolSpan.parent_id
        if (!parentId || parentId.toString() === '0') {
          throw new Error('callTool span should have a parent_id for context propagation')
        }

        assert.strictEqual(callToolSpan.meta.component, 'modelcontextprotocol-sdk')
        assert.strictEqual(callToolSpan.meta['mcp.server.name'], 'test-server')
      })

      // Create a parent span to test context propagation
      const parentSpan = ddTracer.startSpan('test.parent.operation')
      await ddTracer.scope().activate(parentSpan, async () => {
        await testSetup.clientCallTool()
        parentSpan.finish()
      })

      return traceAssertion
    })

    it('should propagate context from parent span to client listTools', async () => {
      const ddTracer = require('../../dd-trace')

      const traceAssertion = agent.assertSomeTraces(traces => {
        const listToolsSpan = traces.flat().find(s => s.name === 'modelcontextprotocol-sdk.listTools')
        if (!listToolsSpan) {
          throw new Error('listTools span not found')
        }

        const parentId = listToolsSpan.parent_id
        if (!parentId || parentId.toString() === '0') {
          throw new Error('listTools span should have a parent_id for context propagation')
        }

        assert.strictEqual(listToolsSpan.meta.component, 'modelcontextprotocol-sdk')
        assert.strictEqual(listToolsSpan.meta['mcp.server.name'], 'test-server')
      })

      // Create a parent span to test context propagation
      const parentSpan = ddTracer.startSpan('test.parent.operation')
      await ddTracer.scope().activate(parentSpan, async () => {
        await testSetup.clientListTools()
        parentSpan.finish()
      })

      return traceAssertion
    })
  })

  describe('Peer Service', () => {
    it('should compute peer service from mcp.server.name', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        const callToolSpan = traces.flat().find(s => s.name === 'modelcontextprotocol-sdk.callTool')
        if (!callToolSpan) {
          throw new Error('callTool span not found')
        }

        // Verify mcp.server.name tag is set
        assert.strictEqual(callToolSpan.meta['mcp.server.name'], 'test-server')

        // Verify peer service is computed from mcp.server.name
        assert.strictEqual(callToolSpan.meta['peer.service'], 'test-server')
        assert.strictEqual(callToolSpan.meta['_dd.peer.service.source'], 'mcp.server.name')
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })
  })
})
