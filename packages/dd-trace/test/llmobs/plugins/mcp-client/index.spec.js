'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  FakeAgent,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../../../integration-tests/helpers')

// The mcp-client package is unavailable on the public npm registry (403 Forbidden),
// so we cannot use useSandbox() which tries to npm-install it.
// Instead, we run the subprocess tests directly from this directory, relying on the
// locally installed mcp-client in the repo root node_modules (installed via yarn link
// or manual install).
const testDir = __dirname

/**
 * Category: tool_client
 * Strategy: Mock server tests for protocol endpoints (subprocess-based ESM integration)
 * Forbidden: VCR cassettes, VCR proxy URLs
 * Required: spanKind 'tool' or 'retrieval', protocol-specific metadata validation
 */
describe('mcp-client LLMObs', () => {
  let agent
  let proc

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc?.kill()
    await agent.stop()
  })

  describe('callTool', () => {
    it('should create a tool span with correct input/output', async () => {
      const collectedLlmobsSpans = []
      const collectedApmSpans = new Map()

      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        for (const item of payload) {
          if (item.spans) {
            for (const span of item.spans) {
              collectedLlmobsSpans.push(span)
            }
          }
        }

        const callToolSpan = collectedLlmobsSpans.find(s => s.name?.includes('callTool'))
        if (!callToolSpan) {
          throw new Error(`Waiting for callTool LLMObs span (have ${collectedLlmobsSpans.length} spans)`)
        }
      }, undefined, undefined, true)

      const apmRes = agent.assertMessageReceived(({ payload }) => {
        assert.ok(Array.isArray(payload))
        for (const trace of payload) {
          for (const span of trace) {
            if (span.name === 'mcp-client.callTool') {
              collectedApmSpans.set(span.name, span)
            }
          }
        }
        if (!collectedApmSpans.has('mcp-client.callTool')) {
          throw new Error('Waiting for mcp-client.callTool APM span')
        }
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(testDir, 'server-llmobs.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      await Promise.all([llmobsRes, apmRes])

      const callToolLlmobsSpan = collectedLlmobsSpans.find(s => s.name?.includes('callTool'))
      const callToolApmSpan = collectedApmSpans.get('mcp-client.callTool')

      assert.ok(callToolLlmobsSpan, 'callTool LLMObs span should exist')
      assert.ok(callToolApmSpan, 'callTool APM span should exist')

      // Validate span kind is 'tool' (not 'llm')
      assert.strictEqual(callToolLlmobsSpan.meta['span.kind'], 'tool', 'callTool should be a tool span')

      // Validate name contains callTool operation
      assert.ok(callToolLlmobsSpan.name.includes('callTool'), 'name should include callTool')
      assert.ok(callToolLlmobsSpan.name.includes('echo'), 'name should include tool name "echo"')

      // Validate input contains tool name and arguments
      assert.ok(callToolLlmobsSpan.meta.input, 'should have input')
      assert.ok(callToolLlmobsSpan.meta.input.value, 'should have input value')
      assert.ok(
        callToolLlmobsSpan.meta.input.value.includes('echo'),
        'input should reference tool name'
      )
      assert.ok(
        callToolLlmobsSpan.meta.input.value.includes('hello'),
        'input should reference tool arguments'
      )

      // Validate output contains the echoed message
      assert.ok(callToolLlmobsSpan.meta.output, 'should have output')
      assert.ok(callToolLlmobsSpan.meta.output.value, 'should have output value')
      assert.strictEqual(callToolLlmobsSpan.meta.output.value, 'hello', 'output should be echoed message')

      // Validate metadata includes server info
      assert.ok(callToolLlmobsSpan.meta.metadata, 'should have metadata')
      assert.strictEqual(
        callToolLlmobsSpan.meta.metadata['mcp.server.name'],
        'test-server',
        'metadata should include server name'
      )

      // Validate status
      assert.strictEqual(callToolLlmobsSpan.status, 'ok', 'should have ok status')
    }).timeout(60000)
  })

  describe('getResource', () => {
    it('should create a retrieval span with documents output', async () => {
      const collectedLlmobsSpans = []

      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        for (const item of payload) {
          if (item.spans) {
            for (const span of item.spans) {
              collectedLlmobsSpans.push(span)
            }
          }
        }

        const resourceSpan = collectedLlmobsSpans.find(s => s.name?.includes('getResource'))
        if (!resourceSpan) {
          throw new Error(`Waiting for getResource LLMObs span (have ${collectedLlmobsSpans.length} spans)`)
        }
      }, undefined, undefined, true)

      proc = await spawnPluginIntegrationTestProcAndExpectExit(testDir, 'server-llmobs.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      await llmobsRes

      const resourceSpan = collectedLlmobsSpans.find(s => s.name?.includes('getResource'))

      assert.ok(resourceSpan, 'getResource LLMObs span should exist')

      // Validate span kind is 'retrieval' (not 'llm')
      assert.strictEqual(resourceSpan.meta['span.kind'], 'retrieval', 'getResource should be a retrieval span')

      // Validate name contains getResource operation and URI
      assert.ok(resourceSpan.name.includes('getResource'), 'name should include getResource')

      // Validate input is the resource URI
      assert.ok(resourceSpan.meta.input, 'should have input')
      assert.ok(resourceSpan.meta.input.value, 'should have input value')
      assert.strictEqual(
        resourceSpan.meta.input.value,
        'file:///test/resource',
        'input should be resource URI'
      )

      // Validate output documents (retrieval IO)
      assert.ok(resourceSpan.meta.output, 'should have output')
      assert.ok(resourceSpan.meta.output.documents, 'should have output documents')
      assert.ok(Array.isArray(resourceSpan.meta.output.documents), 'output documents should be an array')
      assert.strictEqual(resourceSpan.meta.output.documents.length, 1, 'should have one document')

      const doc = resourceSpan.meta.output.documents[0]
      assert.strictEqual(doc.text, 'test resource content', 'document text should match resource content')
      assert.ok(doc.name, 'document should have a name (URI)')

      // Validate metadata includes server info
      assert.ok(resourceSpan.meta.metadata, 'should have metadata')
      assert.strictEqual(
        resourceSpan.meta.metadata['mcp.server.name'],
        'test-server',
        'metadata should include server name'
      )

      // Validate status
      assert.strictEqual(resourceSpan.status, 'ok', 'should have ok status')
    }).timeout(60000)
  })

  describe('getPrompt', () => {
    it('should create a retrieval span with prompt documents output', async () => {
      const collectedLlmobsSpans = []

      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        for (const item of payload) {
          if (item.spans) {
            for (const span of item.spans) {
              collectedLlmobsSpans.push(span)
            }
          }
        }

        const promptSpan = collectedLlmobsSpans.find(s => s.name?.includes('getPrompt'))
        if (!promptSpan) {
          throw new Error(`Waiting for getPrompt LLMObs span (have ${collectedLlmobsSpans.length} spans)`)
        }
      }, undefined, undefined, true)

      proc = await spawnPluginIntegrationTestProcAndExpectExit(testDir, 'server-llmobs.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      await llmobsRes

      const promptSpan = collectedLlmobsSpans.find(s => s.name?.includes('getPrompt'))

      assert.ok(promptSpan, 'getPrompt LLMObs span should exist')

      // Validate span kind is 'retrieval' (not 'llm')
      assert.strictEqual(promptSpan.meta['span.kind'], 'retrieval', 'getPrompt should be a retrieval span')

      // Validate name contains getPrompt operation
      assert.ok(promptSpan.name.includes('getPrompt'), 'name should include getPrompt')
      assert.ok(promptSpan.name.includes('test-prompt'), 'name should include prompt name')

      // Validate input is the prompt name
      assert.ok(promptSpan.meta.input, 'should have input')
      assert.ok(promptSpan.meta.input.value, 'should have input value')
      assert.strictEqual(
        promptSpan.meta.input.value,
        'test-prompt',
        'input should be prompt name'
      )

      // Validate output documents (retrieval IO with prompt messages)
      assert.ok(promptSpan.meta.output, 'should have output')
      assert.ok(promptSpan.meta.output.documents, 'should have output documents')
      assert.ok(Array.isArray(promptSpan.meta.output.documents), 'output documents should be an array')
      assert.ok(promptSpan.meta.output.documents.length >= 1, 'should have at least one document')

      const doc = promptSpan.meta.output.documents[0]
      assert.ok(doc.text, 'document should have text')
      assert.ok(doc.text.includes('Hello hello'), 'document text should contain prompt content')
      assert.ok(doc.name, 'document should have a name (role)')

      // Validate metadata includes server info
      assert.ok(promptSpan.meta.metadata, 'should have metadata')
      assert.strictEqual(
        promptSpan.meta.metadata['mcp.server.name'],
        'test-server',
        'metadata should include server name'
      )

      // Validate status
      assert.strictEqual(promptSpan.status, 'ok', 'should have ok status')
    }).timeout(60000)
  })

  describe('complete', () => {
    it('should create a tool span with completion input/output', async () => {
      const collectedLlmobsSpans = []

      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        for (const item of payload) {
          if (item.spans) {
            for (const span of item.spans) {
              collectedLlmobsSpans.push(span)
            }
          }
        }

        const completeSpan = collectedLlmobsSpans.find(s =>
          s.name?.includes('complete') && !s.name?.includes('callTool')
        )
        if (!completeSpan) {
          throw new Error(`Waiting for complete LLMObs span (have ${collectedLlmobsSpans.length} spans)`)
        }
      }, undefined, undefined, true)

      proc = await spawnPluginIntegrationTestProcAndExpectExit(testDir, 'server-llmobs.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      await llmobsRes

      const completeSpan = collectedLlmobsSpans.find(s =>
        s.name?.includes('complete') && !s.name?.includes('callTool')
      )

      assert.ok(completeSpan, 'complete LLMObs span should exist')

      // Validate span kind is 'tool' (not 'llm')
      assert.strictEqual(completeSpan.meta['span.kind'], 'tool', 'complete should be a tool span')

      // Validate name contains complete operation
      assert.ok(completeSpan.name.includes('complete'), 'name should include complete')

      // Validate input contains ref and argument info
      assert.ok(completeSpan.meta.input, 'should have input')
      assert.ok(completeSpan.meta.input.value, 'should have input value')
      assert.ok(
        completeSpan.meta.input.value.includes('ref/prompt'),
        'input should reference ref type'
      )
      assert.ok(
        completeSpan.meta.input.value.includes('test-prompt'),
        'input should reference ref name'
      )

      // Validate output contains completion values
      assert.ok(completeSpan.meta.output, 'should have output')
      assert.ok(completeSpan.meta.output.value, 'should have output value')
      assert.ok(
        completeSpan.meta.output.value.includes('option1'),
        'output should contain completion values'
      )

      // Validate metadata includes server info
      assert.ok(completeSpan.meta.metadata, 'should have metadata')
      assert.strictEqual(
        completeSpan.meta.metadata['mcp.server.name'],
        'test-server',
        'metadata should include server name'
      )

      // Validate status
      assert.strictEqual(completeSpan.status, 'ok', 'should have ok status')
    }).timeout(60000)
  })

  describe('all operations', () => {
    it('should create LLMObs spans for all four MCP operations', async () => {
      const collectedLlmobsSpans = []
      const expectedOperations = ['callTool', 'getResource', 'getPrompt', 'complete']

      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        for (const item of payload) {
          if (item.spans) {
            for (const span of item.spans) {
              collectedLlmobsSpans.push(span)
            }
          }
        }

        const foundOps = new Set()
        for (const span of collectedLlmobsSpans) {
          for (const op of expectedOperations) {
            if (span.name?.includes(op)) {
              foundOps.add(op)
            }
          }
        }

        if (foundOps.size < expectedOperations.length) {
          throw new Error(
            `Waiting for all LLMObs spans: have ${foundOps.size}/${expectedOperations.length} ` +
            `(${[...foundOps].join(', ')})`
          )
        }
      }, undefined, undefined, true)

      proc = await spawnPluginIntegrationTestProcAndExpectExit(testDir, 'server-llmobs.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      await llmobsRes

      // Verify all operations produced LLMObs spans
      const callToolSpan = collectedLlmobsSpans.find(s => s.name?.includes('callTool'))
      const getResourceSpan = collectedLlmobsSpans.find(s => s.name?.includes('getResource'))
      const getPromptSpan = collectedLlmobsSpans.find(s => s.name?.includes('getPrompt'))
      const completeSpan = collectedLlmobsSpans.find(s =>
        s.name?.includes('complete') && !s.name?.includes('callTool')
      )

      assert.ok(callToolSpan, 'callTool LLMObs span should exist')
      assert.ok(getResourceSpan, 'getResource LLMObs span should exist')
      assert.ok(getPromptSpan, 'getPrompt LLMObs span should exist')
      assert.ok(completeSpan, 'complete LLMObs span should exist')

      // Verify correct span kinds for tool_client category
      assert.strictEqual(callToolSpan.meta['span.kind'], 'tool', 'callTool → tool')
      assert.strictEqual(getResourceSpan.meta['span.kind'], 'retrieval', 'getResource → retrieval')
      assert.strictEqual(getPromptSpan.meta['span.kind'], 'retrieval', 'getPrompt → retrieval')
      assert.strictEqual(completeSpan.meta['span.kind'], 'tool', 'complete → tool')

      // Verify none use 'llm' span kind (tool_client, not llm_client)
      for (const span of [callToolSpan, getResourceSpan, getPromptSpan, completeSpan]) {
        assert.notStrictEqual(span.meta['span.kind'], 'llm', `${span.name} should not be llm span kind`)
      }

      // Verify all spans have ok status
      for (const span of [callToolSpan, getResourceSpan, getPromptSpan, completeSpan]) {
        assert.strictEqual(span.status, 'ok', `${span.name} should have ok status`)
      }

      // Verify tool spans (callTool, complete) have text IO
      assert.ok(callToolSpan.meta.input?.value, 'callTool should have input value')
      assert.ok(callToolSpan.meta.output?.value, 'callTool should have output value')
      assert.ok(completeSpan.meta.input?.value, 'complete should have input value')
      assert.ok(completeSpan.meta.output?.value, 'complete should have output value')

      // Verify retrieval spans (getResource, getPrompt) have retrieval IO
      assert.ok(getResourceSpan.meta.input?.value, 'getResource should have input value')
      assert.ok(getResourceSpan.meta.output?.documents, 'getResource should have output documents')
      assert.ok(getPromptSpan.meta.input?.value, 'getPrompt should have input value')
      assert.ok(getPromptSpan.meta.output?.documents, 'getPrompt should have output documents')

      // Verify metadata on all spans
      for (const span of [callToolSpan, getResourceSpan, getPromptSpan, completeSpan]) {
        assert.ok(span.meta.metadata, `${span.name} should have metadata`)
        assert.strictEqual(
          span.meta.metadata['mcp.server.name'],
          'test-server',
          `${span.name} should have server name in metadata`
        )
      }
    }).timeout(60000)
  })

  describe('error handling', () => {
    it('should capture errors on tool spans', async () => {
      const collectedLlmobsSpans = []

      const llmobsRes = agent.assertLlmObsPayloadReceived(({ payload }) => {
        for (const item of payload) {
          if (item.spans) {
            for (const span of item.spans) {
              collectedLlmobsSpans.push(span)
            }
          }
        }

        // We expect at least 2 callTool spans: one success, one error
        const callToolSpans = collectedLlmobsSpans.filter(s => s.name?.includes('callTool'))
        if (callToolSpans.length < 2) {
          throw new Error(
            `Waiting for callTool spans: have ${callToolSpans.length}/2`
          )
        }
      }, undefined, undefined, true)

      proc = await spawnPluginIntegrationTestProcAndExpectExit(testDir, 'server-llmobs-error.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_ML_APP: 'test',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      await llmobsRes

      const callToolSpans = collectedLlmobsSpans.filter(s => s.name?.includes('callTool'))
      assert.ok(callToolSpans.length >= 2, 'should have at least 2 callTool spans')

      // Find the error span
      const errorSpan = callToolSpans.find(s => s.status === 'error')
      assert.ok(errorSpan, 'should have an error callTool span')

      // Validate error span has tool kind
      assert.strictEqual(errorSpan.meta['span.kind'], 'tool', 'error span should still be tool kind')

      // Validate error span has empty output (error case)
      if (errorSpan.meta.output?.value !== undefined) {
        assert.strictEqual(errorSpan.meta.output.value, '', 'error span output should be empty')
      }

      // Find the successful span
      const successSpan = callToolSpans.find(s => s.status === 'ok')
      assert.ok(successSpan, 'should have a successful callTool span')
      assert.strictEqual(successSpan.meta['span.kind'], 'tool', 'success span should be tool kind')
    }).timeout(60000)
  })
})
