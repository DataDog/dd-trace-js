'use strict'

const assert = require('node:assert')
const { describe, it, beforeEach } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('integrations', () => {
  let StateGraph
  let Annotation
  let langchainMessages

  describe('langgraph', () => {
    const { getEvents } = useLlmObs({ plugin: ['langgraph', 'langchain'] })

    withVersions('langgraph', '@langchain/langgraph', (version) => {
      beforeEach(() => {
        const langgraph = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()
        StateGraph = langgraph.StateGraph
        Annotation = langgraph.Annotation
        langchainMessages = require(`../../../../../../versions/@langchain/langgraph@${version}`)
          .get('@langchain/core/messages')
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

          const app = workflow.compile({ name: 'foobarzoo' })

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
            name: 'foobarzoo',
            inputValue: JSON.stringify({
              messages: [{ role: 'user', content: 'Stream test' }],
            }),
            outputValue: MOCK_STRING,
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

          const app = workflow.compile({ name: 'foobarzoo' })

          const chunks = []
          for await (const chunk of await app.stream({ count: 0 })) {
            chunks.push(chunk)
          }

          assert.ok(chunks.length > 0)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'foobarzoo',
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

          const app = workflow.compile({ name: 'foobarzoo' })

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
            name: 'foobarzoo',
            inputValue: JSON.stringify({ text: '' }),
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })

        // Regression for https://github.com/DataDog/dd-trace-js/issues/8096: BaseMessage
        // instances must render as { content, role } instead of full class dumps.
        it('renders BaseMessage input/output as clean { content, role }', async () => {
          const StateAnnotation = Annotation.Root({
            messages: Annotation({
              reducer: (x, y) => x.concat(y),
              default: () => [],
            }),
          })

          function chatNode () {
            return {
              messages: [new langchainMessages.AIMessage('Pong')],
            }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('chat', chatNode)
            .addEdge('__start__', 'chat')
            .addEdge('chat', '__end__')

          const app = workflow.compile({ name: 'basemessage-graph' })

          const chunks = []
          for await (const chunk of await app.stream({
            messages: [new langchainMessages.HumanMessage('Ping')],
          })) {
            chunks.push(chunk)
          }

          assert.ok(chunks.length > 0)

          const { llmobsSpans } = await getEvents()

          const workflowSpan = llmobsSpans.find(s => s.name === 'basemessage-graph')
          assert.ok(workflowSpan, 'expected workflow span named basemessage-graph')

          assert.strictEqual(
            workflowSpan.meta.input.value,
            JSON.stringify({ messages: [{ content: 'Ping', role: 'user' }] })
          )

          const parsedOutput = JSON.parse(workflowSpan.meta.output.value)
          assert.ok(Array.isArray(parsedOutput.messages))
          const lastMessage = parsedOutput.messages[parsedOutput.messages.length - 1]
          assert.deepStrictEqual(lastMessage, { content: 'Pong', role: 'assistant' })
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

          const app = workflow.compile({ name: 'foobarzoo' })

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
            name: 'foobarzoo',
            inputValue: JSON.stringify({ value: 0 }),
            outputValue: undefined,
            error: {
              type: 'Error',
              message: 'Streaming error',
              stack: MOCK_STRING,
            },
            tags: { ml_app: 'test', integration: 'langgraph' },
          })
        })
      })

      describe('node naming', () => {
        it('creates child workflow spans named after each graph node', async () => {
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
            .addNode('node1', increment)
            .addNode('node2', increment)
            .addEdge('__start__', 'node1')
            .addEdge('node1', 'node2')
            .addEdge('node2', '__end__')

          const app = workflow.compile({ name: 'myGraph' })

          // eslint-disable-next-line no-unused-vars
          for await (const chunk of await app.stream({ count: 0 })) {
            // consume stream
          }

          // 1 outer graph span + 2 node spans
          const { llmobsSpans } = await getEvents(3)

          const graphSpan = llmobsSpans.find(s => s.name === 'myGraph')
          const node1Span = llmobsSpans.find(s => s.name === 'node1')
          const node2Span = llmobsSpans.find(s => s.name === 'node2')

          assert.ok(graphSpan, 'should have an outer workflow span for the graph')
          assert.ok(node1Span, 'should have a child span named after node1')
          assert.ok(node2Span, 'should have a child span named after node2')

          assert.strictEqual(node1Span.meta['span.kind'], 'workflow')
          assert.strictEqual(node2Span.meta['span.kind'], 'workflow')

          // node spans are children of the outer graph span
          assert.strictEqual(node1Span.parent_id, graphSpan.span_id)
          assert.strictEqual(node2Span.parent_id, graphSpan.span_id)
        })

        it('does not create spans for ChannelWrite internal nodes', async () => {
          const StateAnnotation = Annotation.Root({
            value: Annotation({ default: () => 0 }),
          })

          function setVal () {
            return { value: 42 }
          }

          const workflow = new StateGraph(StateAnnotation)
            .addNode('myNode', setVal)
            .addEdge('__start__', 'myNode')
            .addEdge('myNode', '__end__')

          const app = workflow.compile({ name: 'simpleGraph' })

          // eslint-disable-next-line no-unused-vars
          for await (const chunk of await app.stream({ value: 0 })) {
            // consume
          }

          // 1 outer span + 1 node span — no ChannelWrite spans
          const { llmobsSpans } = await getEvents(2)

          assert.ok(llmobsSpans.some(s => s.name === 'simpleGraph'), 'should have outer graph span')
          assert.ok(llmobsSpans.some(s => s.name === 'myNode'), 'should have node span')
          assert.ok(!llmobsSpans.some(s => s.name === 'ChannelWrite'), 'should not have ChannelWrite spans')
        })
      })
    })
  })
})
