'use strict'

const assert = require('node:assert')
const { describe, it, beforeEach, before, after } = require('mocha')

const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_NOT_NULLISH,
  useLlmObs
} = require('../../util')

describe('integrations', () => {
  let langgraph
  let GraphState
  let graph
  let llmobs

  describe('langgraph', () => {
    const { getEvents } = useLlmObs({ plugin: 'langgraph' })

    before(async () => {
      llmobs = require('../../../../../..').llmobs
    })

    withVersions('langgraph', '@langchain/langgraph', (version) => {
      describe('langgraph', () => {
        beforeEach(async () => {
          langgraph = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()

          const { Annotation, StateGraph, START, END } = langgraph

          // Define a simple state annotation for our graph
          GraphState = Annotation.Root({
            counter: Annotation({
              reducer: (current, update) => (current || 0) + (update || 0),
              default: () => 0
            }),
            message: Annotation({
              reducer: (current, update) => update || current,
              default: () => ''
            })
          })

          // Create a simple graph for testing
          const builder = new StateGraph(GraphState)
            .addNode('increment', (state) => {
              return { counter: 1, message: 'incremented' }
            })
            .addNode('double', (state) => {
              return { counter: state.counter, message: 'doubled' }
            })
            .addEdge(START, 'increment')
            .addEdge('increment', 'double')
            .addEdge('double', END)

          graph = builder.compile()
        })

        describe('Pregel.invoke', () => {
          it('submits a workflow span for invoke call', async () => {
            const result = await graph.invoke({
              counter: 5,
              message: 'start'
            })

            assert.ok(result)
            assert.equal(result.counter, 12) // 5 + 1 + 6 (after increment and double)
            assert.equal(result.message, 'doubled')

            // langgraph.invoke internally calls stream, so we get 2 LLMObs spans
            const { apmSpans, llmobsSpans } = await getEvents(2)

            // Find the invoke and stream span events by name
            const invokeSpanEvent = llmobsSpans.find(s => s.name === 'langgraph.invoke')
            const streamSpanEvent = llmobsSpans.find(s => s.name === 'langgraph.stream')

            // Find corresponding APM spans by matching span IDs
            const invokeApmSpan = apmSpans.find(s => s.context().toSpanId() === invokeSpanEvent.span_id)
            const streamApmSpan = apmSpans.find(s => s.context().toSpanId() === streamSpanEvent.span_id)

            // Assert the invoke span (parent)
            assertLlmObsSpanEvent(invokeSpanEvent, {
              span: invokeApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify({ counter: 5, message: 'start' }),
              outputValue: JSON.stringify({ counter: 12, message: 'doubled' }),
              tags: { ml_app: 'test', integration: 'langgraph' }
            })

            // Assert the stream span (child)
            assertLlmObsSpanEvent(streamSpanEvent, {
              span: streamApmSpan,
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify({ counter: 5, message: 'start' }),
              outputValue: MOCK_NOT_NULLISH, // stream output is an async generator
              parentId: invokeApmSpan.span_id,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('does not tag output if there is an error', async () => {
            const { StateGraph, START, END } = langgraph

            const errorBuilder = new StateGraph(GraphState)
              .addNode('error_node', () => {
                throw new Error('Test error in invoke')
              })
              .addEdge(START, 'error_node')
              .addEdge('error_node', END)

            const errorGraph = errorBuilder.compile()

            try {
              await errorGraph.invoke({ counter: 0, message: 'error test' })
              assert.fail('Expected an error to be thrown')
            } catch (err) {
              assert.equal(err.message, 'Test error in invoke')
            }

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify({ counter: 0, message: 'error test' }),
              tags: { ml_app: 'test', integration: 'langgraph' },
              error: {
                type: 'Error',
                message: 'Test error in invoke',
                stack: MOCK_NOT_NULLISH
              }
            })
          })

          it('submits a workflow span with annotation context', async () => {
            const result = await llmobs.annotationContext({ tags: { foo: 'bar' } }, async () => {
              return await graph.invoke({
                counter: 3,
                message: 'annotated'
              })
            })

            assert.ok(result)
            assert.equal(result.counter, 8) // 3 + 1 + 4

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify({ counter: 3, message: 'annotated' }),
              outputValue: JSON.stringify({ counter: 8, message: 'doubled' }),
              tags: { ml_app: 'test', integration: 'langgraph', foo: 'bar' }
            })
          })

          it('handles complex state objects', async () => {
            const { Annotation, StateGraph, START, END } = langgraph

            const ComplexState = Annotation.Root({
              data: Annotation({
                reducer: (current, update) => ({ ...current, ...update }),
                default: () => ({})
              })
            })

            const complexGraph = new StateGraph(ComplexState)
              .addNode('process', (state) => {
                return {
                  data: {
                    processed: true,
                    value: state.data.value * 2
                  }
                }
              })
              .addEdge(START, 'process')
              .addEdge('process', END)
              .compile()

            const result = await complexGraph.invoke({
              data: { value: 10, processed: false }
            })

            assert.ok(result)
            assert.equal(result.data.processed, true)
            assert.equal(result.data.value, 20)

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify({ data: { value: 10, processed: false } }),
              outputValue: JSON.stringify({ data: { value: 20, processed: true } }),
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('handles empty input', async () => {
            const result = await graph.invoke({})
            console.log('result', result)

            assert.ok(result)
            assert.equal(result.counter, 1) // 0 + 1 + 0
            assert.equal(result.message, 'doubled')

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.invoke',
              inputValue: JSON.stringify({}),
              outputValue: JSON.stringify({ counter: 1, message: 'doubled' }),
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })
        })

        describe('Pregel.stream', () => {
          it('submits a workflow span for stream call', async () => {
            const stream = await graph.stream({
              counter: 10,
              message: 'stream start'
            })

            const results = []
            for await (const chunk of stream) {
              results.push(chunk)
            }

            assert.ok(results.length > 0)

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify({ counter: 10, message: 'stream start' }),
              outputValue: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('does not tag output if there is an error', async () => {
            const { StateGraph, START, END } = langgraph

            const errorBuilder = new StateGraph(GraphState)
              .addNode('error_node', () => {
                throw new Error('Test error in stream')
              })
              .addEdge(START, 'error_node')
              .addEdge('error_node', END)

            const errorGraph = errorBuilder.compile()

            try {
              const stream = await errorGraph.stream({ counter: 0, message: 'stream error test' })
              // eslint-disable-next-line no-unused-vars
              for await (const _ of stream) {
                // This will throw
              }
              assert.fail('Expected an error to be thrown')
            } catch (err) {
              assert.equal(err.message, 'Test error in stream')
            }

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify({ counter: 0, message: 'stream error test' }),
              tags: { ml_app: 'test', integration: 'langgraph' },
              error: {
                type: 'Error',
                message: 'Test error in stream',
                stack: MOCK_NOT_NULLISH
              }
            })
          })

          it('submits a workflow span with annotation context', async () => {
            const stream = await llmobs.annotationContext({ tags: { stream_test: 'true' } }, async () => {
              return await graph.stream({
                counter: 2,
                message: 'annotated stream'
              })
            })

            const results = []
            for await (const chunk of stream) {
              results.push(chunk)
            }

            assert.ok(results.length > 0)

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify({ counter: 2, message: 'annotated stream' }),
              outputValue: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph', stream_test: 'true' }
            })
          })

          it('handles complex state objects in stream', async () => {
            const { Annotation, StateGraph, START, END } = langgraph

            const ComplexState = Annotation.Root({
              items: Annotation({
                reducer: (current, update) => [...(current || []), ...(update || [])],
                default: () => []
              })
            })

            const complexGraph = new StateGraph(ComplexState)
              .addNode('add_item', (state) => {
                return { items: ['item1'] }
              })
              .addNode('add_another', (state) => {
                return { items: ['item2'] }
              })
              .addEdge(START, 'add_item')
              .addEdge('add_item', 'add_another')
              .addEdge('add_another', END)
              .compile()

            const stream = await complexGraph.stream({
              items: []
            })

            const results = []
            for await (const chunk of stream) {
              results.push(chunk)
            }

            assert.ok(results.length > 0)

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify({ items: [] }),
              outputValue: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })

          it('handles empty input in stream', async () => {
            const stream = await graph.stream({})

            const results = []
            for await (const chunk of stream) {
              results.push(chunk)
            }

            assert.ok(results.length > 0)

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langgraph.stream',
              inputValue: JSON.stringify({}),
              outputValue: MOCK_NOT_NULLISH,
              tags: { ml_app: 'test', integration: 'langgraph' }
            })
          })
        })
      })
    })
  })
})
