'use strict'

const assert = require('node:assert')
const { describe, it, beforeEach, before } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('integrations', () => {
  let StateGraph
  let Annotation

  describe('langgraph', () => {
    const { getEvents } = useLlmObs({ plugin: 'langgraph' })

    before(async () => {
      // Load langgraph modules
    })

    withVersions('langgraph', '@langchain/langgraph', (version) => {
      beforeEach(() => {
        const langgraph = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()
        StateGraph = langgraph.StateGraph
        Annotation = langgraph.Annotation
      })

      describe('Pregel.invoke', () => {
        it('creates a workflow span for basic graph invocation', async () => {
          // Define simple state using Annotation
          const StateAnnotation = Annotation.Root({
            messages: Annotation({
              reducer: (x, y) => x.concat(y),
              default: () => [],
            }),
          })

          // Pure function node - no API calls
          function chatNode (state) {
            return {
              messages: [{
                role: 'assistant',
                content: 'Hello! This is a mock response.',
              }],
            }
          }

          // Build and execute graph
          const workflow = new StateGraph(StateAnnotation)
            .addNode('chat', chatNode)
            .addEdge('__start__', 'chat')
            .addEdge('chat', '__end__')

          const app = workflow.compile()

          const result = await app.invoke({
            messages: [{ role: 'user', content: 'Hello!' }],
          })

          assert.ok(result)
          assert.ok(result.messages)
          assert.strictEqual(result.messages.length, 2) // Input + output

          const { apmSpans, llmobsSpans } = await getEvents()

          // Validate workflow span
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({
              messages: [{ role: 'user', content: 'Hello!' }],
            }),
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('creates a workflow span with simple state transformation', async () => {
          const StateAnnotation = Annotation.Root({
            input: Annotation({ default: () => '' }),
            result: Annotation({ default: () => '' }),
          })

          // Pure function - deterministic, no side effects
          function processNode (state) {
            return { result: `Processed: ${state.input}` }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('process', processNode)
            .addEdge('__start__', 'process')
            .addEdge('process', '__end__')

          const app = workflow.compile()

          const result = await app.invoke({ input: 'test data' })

          assert.ok(result)
          assert.strictEqual(result.result, 'Processed: test data')

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ input: 'test data' }),
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('creates a workflow span with multiple sequential nodes', async () => {
          const StateAnnotation = Annotation.Root({
            value: Annotation({
              reducer: (x, y) => x + y,
              default: () => 0,
            }),
          })

          // Multiple pure function nodes
          function addOne (state) {
            return { value: 1 }
          }

          function addTwo (state) {
            return { value: 2 }
          }

          function addThree (state) {
            return { value: 3 }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('add_one', addOne)
            .addNode('add_two', addTwo)
            .addNode('add_three', addThree)
            .addEdge('__start__', 'add_one')
            .addEdge('add_one', 'add_two')
            .addEdge('add_two', 'add_three')
            .addEdge('add_three', '__end__')

          const app = workflow.compile()

          const result = await app.invoke({ value: 0 })

          assert.strictEqual(result.value, 6) // 0 + 1 + 2 + 3

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ value: 0 }),
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('creates a workflow span with conditional routing', async () => {
          const StateAnnotation = Annotation.Root({
            value: Annotation({ default: () => 0 }),
            path: Annotation({ default: () => '' }),
          })

          function routeNode (state) {
            // Determine which path to take based on input
            if (state.value > 5) {
              return { path: 'high' }
            } else {
              return { path: 'low' }
            }
          }

          function highPath (state) {
            return { value: state.value * 2 }
          }

          function lowPath (state) {
            return { value: state.value + 10 }
          }

          function routeDecision (state) {
            return state.path
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('router', routeNode)
            .addNode('high', highPath)
            .addNode('low', lowPath)
            .addEdge('__start__', 'router')
            .addConditionalEdges('router', routeDecision, {
              high: 'high',
              low: 'low',
            })
            .addEdge('high', '__end__')
            .addEdge('low', '__end__')

          const app = workflow.compile()

          const result = await app.invoke({ value: 3 })

          assert.strictEqual(result.value, 13) // 3 + 10 (low path)
          assert.strictEqual(result.path, 'low')

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ value: 3 }),
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('creates a workflow span with array state', async () => {
          const StateAnnotation = Annotation.Root({
            items: Annotation({
              reducer: (x, y) => x.concat(y),
              default: () => [],
            }),
          })

          function addItems (state) {
            return {
              items: ['item1', 'item2', 'item3'],
            }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('add_items', addItems)
            .addEdge('__start__', 'add_items')
            .addEdge('add_items', '__end__')

          const app = workflow.compile()

          const result = await app.invoke({ items: [] })

          assert.ok(Array.isArray(result.items))
          assert.strictEqual(result.items.length, 3)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ items: [] }),
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('does not tag output if there is an error', async () => {
          const StateAnnotation = Annotation.Root({
            input: Annotation({ default: () => '' }),
          })

          function errorNode () {
            throw new Error('Test error in node')
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('errorNode', errorNode)
            .addEdge('__start__', 'errorNode')
            .addEdge('errorNode', '__end__')

          const app = workflow.compile()

          try {
            await app.invoke({ input: 'test' })
            assert.fail('Expected error to be thrown')
          } catch (err) {
            assert.ok(err)
            assert.strictEqual(err.message, 'Test error in node')
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ input: 'test' }),
            outputValue: '', // No output on error
            error: {
              type: 'Error',
              message: 'Test error in node',
              stack: MOCK_STRING,
            },
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('handles complex nested state objects', async () => {
          const StateAnnotation = Annotation.Root({
            config: Annotation({ default: () => ({}) }),
            data: Annotation({ default: () => ({}) }),
          })

          function processConfig (state) {
            return {
              config: { processed: true, timestamp: Date.now() },
              data: { result: 'success', count: 42 },
            }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('process', processConfig)
            .addEdge('__start__', 'process')
            .addEdge('process', '__end__')

          const app = workflow.compile()

          const result = await app.invoke({
            config: { raw: true },
            data: { initial: 'value' },
          })

          assert.ok(result.config.processed)
          assert.strictEqual(result.data.result, 'success')

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: MOCK_STRING, // Complex input
            outputValue: MOCK_STRING, // Complex output
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })
      })

      describe('Pregel.stream', () => {
        it('creates a workflow span for streaming execution', async () => {
          const StateAnnotation = Annotation.Root({
            messages: Annotation({
              reducer: (x, y) => x.concat(y),
              default: () => [],
            }),
          })

          function chatNode (state) {
            return {
              messages: [{ role: 'assistant', content: 'Streaming response' }],
            }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('chat', chatNode)
            .addEdge('__start__', 'chat')
            .addEdge('chat', '__end__')

          const app = workflow.compile()

          // Stream execution
          const chunks = []
          for await (const chunk of await app.stream({
            messages: [{ role: 'user', content: 'Stream test' }],
          })) {
            chunks.push(chunk)
          }

          assert.ok(chunks.length > 0)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({
              messages: [{ role: 'user', content: 'Stream test' }],
            }),
            outputValue: MOCK_STRING, // Final streamed output
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('creates a workflow span for streaming with multiple nodes', async () => {
          const StateAnnotation = Annotation.Root({
            count: Annotation({
              reducer: (x, y) => x + y,
              default: () => 0,
            }),
          })

          function increment (state) {
            return { count: 1 }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('increment1', increment)
            .addNode('increment2', increment)
            .addNode('increment3', increment)
            .addEdge('__start__', 'increment1')
            .addEdge('increment1', 'increment2')
            .addEdge('increment2', 'increment3')
            .addEdge('increment3', '__end__')

          const app = workflow.compile()

          const chunks = []
          for await (const chunk of await app.stream({ count: 0 })) {
            chunks.push(chunk)
          }

          assert.ok(chunks.length > 0)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ count: 0 }),
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('creates a workflow span for streaming with state updates', async () => {
          const StateAnnotation = Annotation.Root({
            text: Annotation({
              reducer: (x, y) => x + y,
              default: () => '',
            }),
          })

          function addText (state) {
            return { text: 'chunk' }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('add1', addText)
            .addNode('add2', addText)
            .addEdge('__start__', 'add1')
            .addEdge('add1', 'add2')
            .addEdge('add2', '__end__')

          const app = workflow.compile()

          let finalOutput = ''
          for await (const chunk of await app.stream({ text: '' })) {
            if (chunk.add1?.text) finalOutput += chunk.add1.text
            if (chunk.add2?.text) finalOutput += chunk.add2.text
          }

          assert.ok(finalOutput.length > 0)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ text: '' }),
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        it('does not tag output if streaming encounters an error', async () => {
          const StateAnnotation = Annotation.Root({
            value: Annotation({ default: () => 0 }),
          })

          function normalNode (state) {
            return { value: state.value + 1 }
          }

          function errorNode () {
            throw new Error('Streaming error')
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('normal', normalNode)
            .addNode('error', errorNode)
            .addEdge('__start__', 'normal')
            .addEdge('normal', 'error')
            .addEdge('error', '__end__')

          const app = workflow.compile()

          try {
            // eslint-disable-next-line no-unused-vars
            for await (const chunk of await app.stream({ value: 0 })) {
              // Will throw during iteration
            }
            assert.fail('Expected error to be thrown')
          } catch (err) {
            assert.ok(err)
            assert.strictEqual(err.message, 'Streaming error')
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'langgraph.workflow',
            inputValue: JSON.stringify({ value: 0 }),
            outputValue: '', // No output on error
            error: {
              type: 'Error',
              message: 'Streaming error',
              stack: MOCK_STRING,
            },
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })
      })
    })
  })
})
