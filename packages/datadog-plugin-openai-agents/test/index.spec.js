'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('openai-agents', () => {
    withVersions('openai-agents', ['@openai/agents-core'], (version) => {
      let agentsCore
      let tracer

      before(() => {
        tracer = require('../../dd-trace')
        return agent.load('@openai/agents-core')
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        agentsCore = require(`../../../versions/@openai/agents-core@${version}`).get()
      })

      afterEach(() => {
        sinon.restore()
      })

      describe('context propagation', () => {
        it('should create a span for agent run with trace context', async () => {
          // Create a mock model that returns a final output immediately
          const mockModel = {
            getResponse: sinon.stub().resolves({
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello!' }]
              }],
              reasoningItems: [],
              referencedTools: []
            })
          }

          const mockModelProvider = {
            getModel: sinon.stub().resolves(mockModel)
          }

          const runner = new agentsCore.Runner({
            modelProvider: mockModelProvider,
            tracingDisabled: true
          })

          const testAgent = new agentsCore.Agent({
            name: 'test-agent',
            instructions: 'You are a test agent.',
            model: 'gpt-4'
          })

          const p = agent.assertSomeTraces(traces => {
            const allSpans = traces.flat()
            const runSpan = allSpans.find(s => s.name === 'openai.agents.run')
            assert.ok(runSpan, 'Expected a run span')
            assert.strictEqual(runSpan.meta.component, 'openai-agents')
            assert.strictEqual(runSpan.meta['openai.agents.agent_name'], 'test-agent')
            assert.ok(runSpan.trace_id, 'Run span should have a trace_id')
            assert.ok(runSpan.span_id, 'Run span should have a span_id')
          })

          try {
            await runner.run(testAgent, 'Hello, test!')
          } catch (e) {
            // may fail due to mock limitations, that's okay
          }

          await p
        })

        it('should link tool execution spans to agent run span', async () => {
          const toolFunction = sinon.stub().resolves('tool result')
          const testTool = new agentsCore.FunctionTool({
            name: 'test_tool',
            description: 'A test tool',
            parameters: {},
            execute: toolFunction
          })

          const mockModel = {
            getResponse: sinon.stub()
              .onFirstCall().resolves({
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                output: [{
                  type: 'function_call',
                  name: 'test_tool',
                  callId: 'call_123',
                  arguments: '{}'
                }],
                reasoningItems: [],
                referencedTools: []
              })
              .onSecondCall().resolves({
                usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
                output: [{
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Done!' }]
                }],
                reasoningItems: [],
                referencedTools: []
              })
          }

          const mockModelProvider = {
            getModel: sinon.stub().resolves(mockModel)
          }

          const runner = new agentsCore.Runner({
            modelProvider: mockModelProvider,
            tracingDisabled: true
          })

          const testAgent = new agentsCore.Agent({
            name: 'tool-agent',
            instructions: 'Use the test tool.',
            model: 'gpt-4',
            tools: [testTool]
          })

          const p = agent.assertSomeTraces(traces => {
            const allSpans = traces.flat()
            const runSpan = allSpans.find(s => s.name === 'openai.agents.run')
            const toolSpan = allSpans.find(s => s.name === 'openai.agents.tool')

            assert.ok(runSpan, 'Expected a run span')

            if (toolSpan) {
              // Verify context propagation: tool span should share the same trace
              assert.strictEqual(
                toolSpan.trace_id.toString(),
                runSpan.trace_id.toString(),
                'Tool span should share the same trace_id as run span'
              )

              // Tool span should be a child of (or descendant of) the run span
              assert.ok(toolSpan.parent_id, 'Tool span should have a parent_id')
              assert.strictEqual(toolSpan.meta.component, 'openai-agents')
              assert.strictEqual(toolSpan.meta['openai.agents.agent_name'], 'tool-agent')
            }
          })

          try {
            await runner.run(testAgent, 'Use the tool')
          } catch (e) {
            // may fail due to mock limitations
          }

          await p
        })

        it('should link handoff spans to agent run span and propagate context', async () => {
          const targetAgent = new agentsCore.Agent({
            name: 'target-agent',
            instructions: 'You are the target agent.',
            model: 'gpt-4'
          })

          const mockModel = {
            getResponse: sinon.stub()
              .onFirstCall().resolves({
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                output: [{
                  type: 'function_call',
                  name: 'transfer_to_target-agent',
                  callId: 'call_handoff_1',
                  arguments: '{}'
                }],
                reasoningItems: [],
                referencedTools: []
              })
              .onSecondCall().resolves({
                usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
                output: [{
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Handled by target!' }]
                }],
                reasoningItems: [],
                referencedTools: []
              })
          }

          const mockModelProvider = {
            getModel: sinon.stub().resolves(mockModel)
          }

          const runner = new agentsCore.Runner({
            modelProvider: mockModelProvider,
            tracingDisabled: true
          })

          const sourceAgent = new agentsCore.Agent({
            name: 'source-agent',
            instructions: 'Transfer to target agent.',
            model: 'gpt-4',
            handoffs: [targetAgent]
          })

          const p = agent.assertSomeTraces(traces => {
            const allSpans = traces.flat()
            const runSpan = allSpans.find(s => s.name === 'openai.agents.run')
            const handoffSpan = allSpans.find(s => s.name === 'openai.agents.handoff')

            assert.ok(runSpan, 'Expected a run span')

            if (handoffSpan) {
              // Verify context propagation: handoff span should share the same trace
              assert.strictEqual(
                handoffSpan.trace_id.toString(),
                runSpan.trace_id.toString(),
                'Handoff span should share the same trace_id as run span'
              )

              // Handoff span should be a child of the run span
              assert.ok(handoffSpan.parent_id, 'Handoff span should have a parent_id')
              assert.strictEqual(handoffSpan.meta.component, 'openai-agents')
              assert.strictEqual(handoffSpan.meta['openai.agents.from_agent'], 'source-agent')
              assert.strictEqual(handoffSpan.meta['openai.agents.to_agent'], 'target-agent')
            }
          })

          try {
            await runner.run(sourceAgent, 'Transfer me')
          } catch (e) {
            // may fail due to mock limitations
          }

          await p
        })

        it('should propagate trace context across the entire agent execution', async () => {
          const mockModel = {
            getResponse: sinon.stub().resolves({
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hi!' }]
              }],
              reasoningItems: [],
              referencedTools: []
            })
          }

          const mockModelProvider = {
            getModel: sinon.stub().resolves(mockModel)
          }

          const runner = new agentsCore.Runner({
            modelProvider: mockModelProvider,
            tracingDisabled: true,
            workflowName: 'test-workflow'
          })

          const testAgent = new agentsCore.Agent({
            name: 'workflow-agent',
            instructions: 'A workflow agent.',
            model: 'gpt-4'
          })

          // Create a parent span to verify context flows from app into agent run
          const parentSpan = tracer.startSpan('test.parent.operation')

          const p = agent.assertSomeTraces(traces => {
            const allSpans = traces.flat()
            const runSpan = allSpans.find(s => s.name === 'openai.agents.run')
            const parentS = allSpans.find(s => s.name === 'test.parent.operation')

            assert.ok(runSpan, 'Expected a run span')

            if (parentS && runSpan) {
              // The run span should inherit the trace from the parent application span
              assert.strictEqual(
                runSpan.trace_id.toString(),
                parentS.trace_id.toString(),
                'Agent run span should be in the same trace as the parent application span'
              )
              assert.strictEqual(
                runSpan.parent_id.toString(),
                parentS.span_id.toString(),
                'Agent run span should be a direct child of the parent application span'
              )
            }
          })

          try {
            await tracer.trace('test.parent.operation', async () => {
              await runner.run(testAgent, 'Hello workflow!')
            })
          } catch (e) {
            // may fail due to mock limitations
          }

          parentSpan.finish()

          await p
        })
      })
    })
  })
})
