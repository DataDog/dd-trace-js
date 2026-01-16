'use strict'

const assert = require('node:assert')
const { describe, it, before } = require('mocha')

const { useEnv } = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_NOT_NULLISH,
  MOCK_STRING,
  useLlmObs
} = require('../../util')

/**
 * Find the APM span that matches the LLMObs span by span_id.
 * LangGraph creates multiple spans (invoke + _runWithRetry internal spans),
 * and due to flush timing, they may arrive in any order.
 *
 * The APM span_id is a BigInt (from msgpack decode with useBigInt64: true).
 * The LLMObs span_id is a string (decimal representation).
 */
function findMatchingApmSpan (apmSpans, llmobsSpan) {
  const llmobsSpanId = llmobsSpan.span_id
  return apmSpans.find(span => {
    // APM span_id is a BigInt, convert to string for comparison
    const apmSpanId = String(span.span_id)
    return apmSpanId === llmobsSpanId
  })
}

/*
 * LangGraph LLMObs Integration Tests
 *
 * These tests verify that the LLMObs plugin correctly instruments `@langchain/langgraph`
 * workflows. LangGraph is a state machine orchestration library that enables building
 * complex, stateful agent workflows.
 *
 * Key concepts:
 * - StateGraph: Defines the workflow structure with nodes and edges
 * - Pregel: The compiled graph that executes the workflow (invoke/stream)
 * - State Channels: User-defined state structure with reducers
 *
 * LangGraph spans should be traced as 'workflow' kind since they orchestrate
 * multiple operations, similar to LangChain's RunnableSequence.
 *
 * Note: LangGraph does NOT track token usage directly. Token metrics come from
 * underlying LLM integrations (OpenAI, Anthropic, etc.) when nodes call LLM APIs.
 */

describe('Plugin', () => {
  // LangGraph doesn't require API keys directly - it orchestrates other components
  // But underlying LLM calls might need keys
  useEnv({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '<not-a-real-key>',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>'
  })

  describe('langgraph', () => {
    const { getEvents } = useLlmObs({ plugin: 'langgraph' })

    withVersions('langgraph', '@langchain/langgraph', (version, moduleName, realVersion) => {
      let StateGraph
      let START
      let END

      before(() => {
        const langgraph = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()
        StateGraph = langgraph.StateGraph
        START = langgraph.START
        END = langgraph.END
      })

      describe('workflow execution', () => {
        describe('Pregel.invoke()', () => {
          it('creates a workflow span for basic graph execution', async () => {
            // Define a simple state graph
            const graphState = {
              messages: {
                value: (x, y) => x.concat(y),
                default: () => []
              },
              count: {
                value: (x, y) => y,
                default: () => 0
              }
            }

            const workflow = new StateGraph({ channels: graphState })

            // Add a simple node that increments count and adds a message
            const processNode = async (state) => {
              return {
                messages: [`Response ${state.count + 1}`],
                count: state.count + 1
              }
            }

            workflow.addNode('process', processNode)
            workflow.addEdge(START, 'process')
            workflow.addEdge('process', END)

            const app = workflow.compile()

            const input = {
              messages: ['User: Hello'],
              count: 0
            }

            const result = await app.invoke(input)

            // Verify the workflow executed correctly
            assert.equal(result.count, 1)
            assert.equal(result.messages.length, 2)

            const { apmSpans, llmobsSpans } = await getEvents()
            const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: matchingApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify(input),
              outputValue: JSON.stringify(result),
              metadata: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('captures input state with multiple channels', async () => {
            // Test with a more complex state structure
            const graphState = {
              query: {
                value: (x, y) => y || x,
                default: () => ''
              },
              context: {
                value: (x, y) => x.concat(y),
                default: () => []
              },
              result: {
                value: (x, y) => y,
                default: () => null
              }
            }

            const workflow = new StateGraph({ channels: graphState })

            const searchNode = async (state) => {
              return {
                context: [`Found result for: ${state.query}`],
                result: 'search_complete'
              }
            }

            workflow.addNode('search', searchNode)
            workflow.addEdge(START, 'search')
            workflow.addEdge('search', END)

            const app = workflow.compile()

            const input = {
              query: 'What is LangGraph?',
              context: [],
              result: null
            }

            const result = await app.invoke(input)

            const { apmSpans, llmobsSpans } = await getEvents()
            const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: matchingApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify(input),
              outputValue: JSON.stringify(result),
              metadata: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('captures workflow with conditional edges', async () => {
            const graphState = {
              value: {
                value: (x, y) => y,
                default: () => 0
              },
              iterations: {
                value: (x, y) => y,
                default: () => 0
              }
            }

            const workflow = new StateGraph({ channels: graphState })

            const incrementNode = async (state) => {
              return {
                value: state.value + 1,
                iterations: state.iterations + 1
              }
            }

            const shouldContinue = (state) => {
              return state.iterations >= 3 ? END : 'increment'
            }

            workflow.addNode('increment', incrementNode)
            workflow.addEdge(START, 'increment')
            workflow.addConditionalEdges('increment', shouldContinue, {
              increment: 'increment',
              [END]: END
            })

            const app = workflow.compile()

            const input = { value: 0, iterations: 0 }
            const result = await app.invoke(input)

            // Should have incremented 3 times
            assert.equal(result.iterations, 3)
            assert.equal(result.value, 3)

            const { apmSpans, llmobsSpans } = await getEvents()
            const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: matchingApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify(input),
              outputValue: JSON.stringify(result),
              metadata: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('captures workflow with runName in config', async () => {
            const graphState = {
              data: {
                value: (x, y) => y,
                default: () => null
              }
            }

            const workflow = new StateGraph({ channels: graphState })

            const processNode = async (state) => {
              return { data: 'processed' }
            }

            workflow.addNode('process', processNode)
            workflow.addEdge(START, 'process')
            workflow.addEdge('process', END)

            const app = workflow.compile()

            const input = { data: 'input' }
            const result = await app.invoke(input, {
              runName: 'my-custom-workflow'
            })

            const { apmSpans, llmobsSpans } = await getEvents()
            const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: matchingApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify(input),
              outputValue: JSON.stringify(result),
              metadata: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })
        })

        describe('Pregel.stream()', () => {
          it('creates a workflow span for streaming execution', async () => {
            const graphState = {
              messages: {
                value: (x, y) => x.concat(y),
                default: () => []
              }
            }

            const workflow = new StateGraph({ channels: graphState })

            const respondNode = async (state) => {
              return {
                messages: ['Streaming response']
              }
            }

            workflow.addNode('respond', respondNode)
            workflow.addEdge(START, 'respond')
            workflow.addEdge('respond', END)

            const app = workflow.compile()

            const input = { messages: ['User message'] }

            // Consume the stream
            const chunks = []
            const stream = await app.stream(input)
            for await (const chunk of stream) {
              chunks.push(chunk)
              assert.ok(chunk)
            }

            // Should have received at least one chunk
            assert.ok(chunks.length > 0)

            const { apmSpans, llmobsSpans } = await getEvents()
            const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

            // Streaming should produce the same workflow span as invoke
            // The output is aggregated from stream chunks into the final state
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: matchingApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify(input),
              outputValue: MOCK_STRING,
              metadata: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('reconstructs final state from stream chunks', async () => {
            const graphState = {
              count: {
                value: (x, y) => y,
                default: () => 0
              },
              log: {
                value: (x, y) => x.concat(y),
                default: () => []
              }
            }

            const workflow = new StateGraph({ channels: graphState })

            const stepNode = async (state) => {
              return {
                count: state.count + 1,
                log: [`Step ${state.count + 1} completed`]
              }
            }

            const shouldContinue = (state) => {
              return state.count >= 2 ? END : 'step'
            }

            workflow.addNode('step', stepNode)
            workflow.addEdge(START, 'step')
            workflow.addConditionalEdges('step', shouldContinue, {
              step: 'step',
              [END]: END
            })

            const app = workflow.compile()

            const input = { count: 0, log: [] }

            const chunks = []
            const stream = await app.stream(input)
            for await (const chunk of stream) {
              chunks.push(chunk)
            }

            // Should have streamed multiple state updates
            assert.ok(chunks.length >= 2)

            const { apmSpans, llmobsSpans } = await getEvents()
            const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: matchingApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify(input),
              outputValue: MOCK_STRING,
              metadata: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })
        })
      })

      describe('metadata', () => {
        it('captures recursionLimit from config', async () => {
          const graphState = {
            data: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const processNode = async (state) => {
            return { data: 'processed' }
          }

          workflow.addNode('process', processNode)
          workflow.addEdge(START, 'process')
          workflow.addEdge('process', END)

          const app = workflow.compile()

          const input = { data: 'input' }
          await app.invoke(input, {
            recursionLimit: 50
          })

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          // The recursionLimit should be captured in metadata
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify(input),
            outputValue: MOCK_STRING,
            metadata: { recursionLimit: 50 },
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })

        it('only includes allowed metadata keys', async () => {
          const graphState = {
            data: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const processNode = async (state) => {
            return { data: 'processed' }
          }

          workflow.addNode('process', processNode)
          workflow.addEdge(START, 'process')
          workflow.addEdge('process', END)

          const app = workflow.compile()

          const input = { data: 'input' }
          await app.invoke(input, {
            runName: 'test-run',
            recursionLimit: 25,
            // These should NOT appear in metadata as they may contain sensitive info
            configurable: { secret: 'should-not-appear' },
            callbacks: []
          })

          const { llmobsSpans } = await getEvents()

          // Verify only allowed keys are in metadata
          const metadata = llmobsSpans[0].meta.metadata
          assert.ok(!metadata.configurable, 'configurable should not be in metadata')
          assert.ok(!metadata.callbacks, 'callbacks should not be in metadata')
          assert.ok(!metadata.secret, 'secret should not be in metadata')
        })
      })

      describe('error handling', () => {
        it('captures errors when node throws exception', async () => {
          const graphState = {
            data: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const errorNode = async (state) => {
            throw new Error('Intentional node error for testing')
          }

          workflow.addNode('error', errorNode)
          workflow.addEdge(START, 'error')
          workflow.addEdge('error', END)

          const app = workflow.compile()

          let caughtError = null
          try {
            await app.invoke({ data: 'input' })
          } catch (err) {
            caughtError = err
          }

          // Verify error was thrown
          assert.ok(caughtError)
          assert.ok(caughtError.message.includes('Intentional node error'))

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify({ data: 'input' }),
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' },
            error: {
              type: 'Error',
              message: MOCK_STRING,
              stack: MOCK_NOT_NULLISH
            }
          })
        })

        it('captures errors with invalid input', async () => {
          const graphState = {
            messages: {
              value: (x, y) => x.concat(y),
              default: () => []
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const processNode = async (state) => {
            return { messages: ['response'] }
          }

          workflow.addNode('process', processNode)
          workflow.addEdge(START, 'process')
          workflow.addEdge('process', END)

          const app = workflow.compile()

          let caughtError = null
          try {
            // Pass null which should cause an error
            await app.invoke(null)
          } catch (err) {
            caughtError = err
          }

          assert.ok(caughtError)

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: 'null', // null input is captured as the string "null"
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' },
            error: {
              type: MOCK_STRING,
              message: MOCK_STRING,
              stack: MOCK_NOT_NULLISH
            }
          })
        })

        it('captures errors during streaming', async () => {
          const graphState = {
            data: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const errorNode = async (state) => {
            throw new Error('Stream error during execution')
          }

          workflow.addNode('error', errorNode)
          workflow.addEdge(START, 'error')
          workflow.addEdge('error', END)

          const app = workflow.compile()

          let caughtError = null
          try {
            const stream = await app.stream({ data: 'input' })
            for await (const chunk of stream) {
              // This should throw
              assert.ok(chunk)
            }
          } catch (err) {
            caughtError = err
          }

          assert.ok(caughtError)

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.stream',
            inputValue: JSON.stringify({ data: 'input' }),
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' },
            error: {
              type: 'Error',
              message: MOCK_STRING,
              stack: MOCK_NOT_NULLISH
            }
          })
        })

        it('does not tag output when error occurs', async () => {
          const graphState = {
            data: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const errorNode = async (state) => {
            throw new Error('Error before output')
          }

          workflow.addNode('error', errorNode)
          workflow.addEdge(START, 'error')
          workflow.addEdge('error', END)

          const app = workflow.compile()

          try {
            await app.invoke({ data: 'input' })
          } catch (err) {
            // Expected
          }

          const { llmobsSpans } = await getEvents()

          // Output should be empty or undefined when error occurs
          const outputValue = llmobsSpans[0].meta.output?.value
          assert.ok(
            outputValue === undefined || outputValue === '' || outputValue === null,
            'Output should not be tagged when error occurs'
          )
        })
      })

      describe('nested workflows', () => {
        it('captures parent-child relationship for nested graphs', async () => {
          // Create an inner workflow
          const innerState = {
            value: {
              value: (x, y) => y,
              default: () => 0
            }
          }

          const innerWorkflow = new StateGraph({ channels: innerState })

          const innerNode = async (state) => {
            return { value: state.value * 2 }
          }

          innerWorkflow.addNode('double', innerNode)
          innerWorkflow.addEdge(START, 'double')
          innerWorkflow.addEdge('double', END)

          const innerApp = innerWorkflow.compile()

          // Create outer workflow that uses inner workflow
          const outerState = {
            input: {
              value: (x, y) => y,
              default: () => 0
            },
            output: {
              value: (x, y) => y,
              default: () => 0
            }
          }

          const outerWorkflow = new StateGraph({ channels: outerState })

          const outerNode = async (state) => {
            // Call inner workflow
            const result = await innerApp.invoke({ value: state.input })
            return { output: result.value }
          }

          outerWorkflow.addNode('process', outerNode)
          outerWorkflow.addEdge(START, 'process')
          outerWorkflow.addEdge('process', END)

          const outerApp = outerWorkflow.compile()

          const input = { input: 5, output: 0 }
          const result = await outerApp.invoke(input)

          // 5 * 2 = 10
          assert.equal(result.output, 10)

          // Request 2 LLMObs spans and 2 APM spans (nested workflows create separate trace batches)
          const { apmSpans, llmobsSpans } = await getEvents(2, 2)

          // Find the matching APM spans by span_id
          const outerApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])
          const innerApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[1])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: outerApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify(input),
            outputValue: JSON.stringify(result),
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })

          // Inner workflow span should be child of outer
          assertLlmObsSpanEvent(llmobsSpans[1], {
            span: innerApmSpan,
            parentId: outerApmSpan.span_id,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify({ value: 5 }),
            outputValue: JSON.stringify({ value: 10 }),
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })
      })

      describe('complex state handling', () => {
        it('handles empty input state', async () => {
          const graphState = {
            data: {
              value: (x, y) => y,
              default: () => 'default_value'
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const processNode = async (state) => {
            return { data: state.data + '_processed' }
          }

          workflow.addNode('process', processNode)
          workflow.addEdge(START, 'process')
          workflow.addEdge('process', END)

          const app = workflow.compile()

          // Invoke with empty object - defaults should be used
          const result = await app.invoke({})

          assert.equal(result.data, 'default_value_processed')

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify({}),
            outputValue: JSON.stringify(result),
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })

        it('handles array state channels', async () => {
          const graphState = {
            items: {
              value: (x, y) => x.concat(y),
              default: () => []
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const addItemNode = async (state) => {
            return { items: [`item_${state.items.length + 1}`] }
          }

          const shouldContinue = (state) => {
            return state.items.length >= 3 ? END : 'addItem'
          }

          workflow.addNode('addItem', addItemNode)
          workflow.addEdge(START, 'addItem')
          workflow.addConditionalEdges('addItem', shouldContinue, {
            addItem: 'addItem',
            [END]: END
          })

          const app = workflow.compile()

          const input = { items: [] }
          const result = await app.invoke(input)

          assert.equal(result.items.length, 3)
          assert.deepEqual(result.items, ['item_1', 'item_2', 'item_3'])

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify(input),
            outputValue: JSON.stringify(result),
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })

        it('handles object state with nested properties', async () => {
          const graphState = {
            user: {
              value: (x, y) => ({ ...x, ...y }),
              default: () => ({})
            },
            metadata: {
              value: (x, y) => ({ ...x, ...y }),
              default: () => ({})
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const enrichNode = async (state) => {
            return {
              user: {
                ...state.user,
                enriched: true
              },
              metadata: {
                timestamp: Date.now(),
                source: 'langgraph'
              }
            }
          }

          workflow.addNode('enrich', enrichNode)
          workflow.addEdge(START, 'enrich')
          workflow.addEdge('enrich', END)

          const app = workflow.compile()

          const input = {
            user: { name: 'Alice', age: 30 },
            metadata: {}
          }
          const result = await app.invoke(input)

          assert.ok(result.user.enriched)
          assert.equal(result.user.name, 'Alice')
          assert.ok(result.metadata.timestamp)

          const { apmSpans, llmobsSpans } = await getEvents()
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify(input),
            outputValue: MOCK_STRING, // Contains timestamp so can't match exactly
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })
      })

      /**
       * Tests with real LLM calls via VCR cassettes.
       *
       * These tests create LangGraph workflows that include actual LLM API calls
       * using LangChain's ChatOpenAI. The VCR proxy (http://127.0.0.1:9126/vcr/openai)
       * records/replays API responses to avoid incurring real API costs.
       *
       * These tests verify that:
       * 1. LangGraph workflow spans are created correctly
       * 2. Child LLM spans from LangChain are properly nested
       * 3. Token metrics from the LLM are captured
       *
       * NOTE: These tests are currently skipped because they require loading
       * `@langchain/openai` which has separate versioning from `@langchain/langgraph`.
       * The test framework's withVersions helper doesn't support loading multiple
       * packages with different version ranges simultaneously.
       *
       * TODO: Implement proper VCR cassette tests once a solution for multi-package
       * version loading is available.
       */
      describe.skip('with real LLM calls (VCR)', () => {
        let ChatOpenAI

        beforeEach(() => {
          // Load LangChain OpenAI with VCR proxy configuration
          const langchainOpenai = require(`../../../../../../versions/langchain@${version}`)
            .get('@langchain/openai')
          ChatOpenAI = langchainOpenai.ChatOpenAI
        })

        /**
         * Helper to create a ChatOpenAI instance pointing to VCR proxy
         */
        function getChatModel (options = {}) {
          return new ChatOpenAI({
            model: 'gpt-3.5-turbo',
            configuration: {
              baseURL: 'http://127.0.0.1:9126/vcr/openai'
            },
            ...options
          })
        }

        it('creates workflow span with child LLM span for simple agent', async () => {
          const graphState = {
            messages: {
              value: (x, y) => x.concat(y),
              default: () => []
            },
            response: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const model = getChatModel()

          // Agent node that calls the LLM
          const agentNode = async (state) => {
            const lastMessage = state.messages[state.messages.length - 1]
            const response = await model.invoke(lastMessage)
            return {
              messages: [response.content],
              response: response.content
            }
          }

          workflow.addNode('agent', agentNode)
          workflow.addEdge(START, 'agent')
          workflow.addEdge('agent', END)

          const app = workflow.compile()

          const input = {
            messages: ['What is 2 + 2? Answer in one word.'],
            response: null
          }

          const result = await app.invoke(input)

          // Verify workflow executed and got a response
          assert.ok(result.response)
          assert.ok(result.messages.length >= 2)

          // We expect 1 LangGraph workflow span
          // The underlying LangChain LLM call creates its own span via the langchain plugin
          const { apmSpans, llmobsSpans } = await getEvents(1)
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify(input),
            outputValue: MOCK_STRING,
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })

        it('creates workflow span for multi-turn conversation agent', async () => {
          const graphState = {
            messages: {
              value: (x, y) => x.concat(y),
              default: () => []
            },
            turn_count: {
              value: (x, y) => y,
              default: () => 0
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          const model = getChatModel({ temperature: 0 })

          // Agent node that processes messages
          const agentNode = async (state) => {
            const userMessage = state.messages[state.messages.length - 1]
            const response = await model.invoke(userMessage)
            return {
              messages: [response.content],
              turn_count: state.turn_count + 1
            }
          }

          // Conditional edge to continue or end
          const shouldContinue = (state) => {
            return state.turn_count >= 2 ? END : 'agent'
          }

          workflow.addNode('agent', agentNode)
          workflow.addEdge(START, 'agent')
          workflow.addConditionalEdges('agent', shouldContinue, {
            agent: 'agent',
            [END]: END
          })

          const app = workflow.compile()

          const input = {
            messages: ['Say "hello" and nothing else.'],
            turn_count: 0
          }

          const result = await app.invoke(input, {
            recursionLimit: 10
          })

          // Should have completed 2 turns
          assert.equal(result.turn_count, 2)
          assert.ok(result.messages.length >= 3) // Original + 2 responses

          const { apmSpans, llmobsSpans } = await getEvents(1)
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: JSON.stringify(input),
            outputValue: MOCK_STRING,
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' }
          })
        })

        it('captures error from LLM call within workflow', async () => {
          const graphState = {
            query: {
              value: (x, y) => y,
              default: () => ''
            },
            result: {
              value: (x, y) => y,
              default: () => null
            }
          }

          const workflow = new StateGraph({ channels: graphState })

          // Create a model with an invalid model name to trigger error
          const invalidModel = new ChatOpenAI({
            model: 'invalid-model-name',
            configuration: {
              baseURL: 'http://127.0.0.1:9126/vcr/openai'
            },
            maxRetries: 0
          })

          const agentNode = async (state) => {
            const response = await invalidModel.invoke(state.query)
            return { result: response.content }
          }

          workflow.addNode('agent', agentNode)
          workflow.addEdge(START, 'agent')
          workflow.addEdge('agent', END)

          const app = workflow.compile()

          let caughtError = null
          try {
            await app.invoke({ query: 'Hello', result: null })
          } catch (err) {
            caughtError = err
          }

          // Should have caught an error from the invalid model
          assert.ok(caughtError)

          const { apmSpans, llmobsSpans } = await getEvents(1)
          const matchingApmSpan = findMatchingApmSpan(apmSpans, llmobsSpans[0])

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: matchingApmSpan,
            spanKind: 'workflow',
            name: 'langgraph.invoke',
            inputValue: MOCK_STRING,
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'langgraph' },
            error: {
              type: MOCK_STRING,
              message: MOCK_STRING,
              stack: MOCK_NOT_NULLISH
            }
          })
        })
      })
    })
  })
})
