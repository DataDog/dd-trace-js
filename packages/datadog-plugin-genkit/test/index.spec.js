'use strict'

const assert = require('node:assert/strict')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  describe('genkit', () => {
    withVersions('genkit', ['@genkit-ai/core'], version => {
      let ai

      before(async () => {
        await agent.load('genkit')
        const { genkit } = require(`../../../versions/genkit@${version}`).get('genkit/beta')
        ai = genkit({ name: 'datadog-genkit-test' })
      })

      after(() => agent.close())

      function assertSpan (expected) {
        return agent.assertFirstTraceSpan({
          service: 'test',
          type: 'genkit',
          ...expected,
          meta: {
            component: 'genkit',
            ...expected.meta,
          },
        })
      }

      it('instruments model actions', async () => {
        const model = ai.defineModel({ name: 'local/test-model' }, async () => ({
          message: { role: 'model', content: [{ text: 'hello' }] },
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }))
        const spanPromise = assertSpan({
          name: 'genkit.request',
          resource: 'local/test-model',
          meta: {
            'genkit.operation.type': 'generation',
            'genkit.action.name': 'local/test-model',
            'span.kind': 'client',
          },
        })

        await model({ messages: [{ role: 'user', content: [{ text: 'hello' }] }] })
        await spanPromise
      })

      it('instruments flows and named flow steps', async () => {
        const flow = ai.defineFlow({ name: 'testFlow' }, input => ai.run('testStep', () => input))
        const tracesPromise = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.strictEqual(spans.length, 2)

          const flowSpan = spans.find(span => span.meta['genkit.operation.type'] === 'flow')
          const stepSpan = spans.find(span => span.meta['genkit.operation.type'] === 'flowStep')
          assert.strictEqual(flowSpan.name, 'genkit.workflow')
          assert.strictEqual(flowSpan.resource, 'testFlow')
          assert.strictEqual(stepSpan.name, 'genkit.workflow')
          assert.strictEqual(stepSpan.resource, 'testStep')
          assert.strictEqual(stepSpan.parent_id.toString(), flowSpan.span_id.toString())
        })

        await flow('input')
        await tracesPromise
      })

      it('instruments tool actions', async () => {
        const tool = ai.defineTool({ name: 'testTool' }, async input => input)
        const spanPromise = assertSpan({
          name: 'genkit.tool',
          resource: 'testTool',
          meta: {
            'genkit.operation.type': 'tool',
            'genkit.action.name': 'testTool',
            'span.kind': 'internal',
          },
        })

        await tool({ value: 'hello' })
        await spanPromise
      })

      it('instruments retriever actions', async () => {
        const retriever = ai.defineRetriever({ name: 'testRetriever' }, async () => ({ documents: [] }))
        const spanPromise = assertSpan({
          name: 'genkit.request',
          resource: 'testRetriever',
          meta: {
            'genkit.operation.type': 'retrieval',
            'genkit.action.name': 'testRetriever',
            'span.kind': 'client',
          },
        })

        await retriever({ query: { content: [{ text: 'hello' }] } })
        await spanPromise
      })

      it('instruments embedder actions', async () => {
        const embedder = ai.defineEmbedder({ name: 'testEmbedder' }, async documents => ({
          embeddings: documents.map(() => ({ embedding: [1, 2, 3] })),
        }))
        const spanPromise = assertSpan({
          name: 'genkit.request',
          resource: 'testEmbedder',
          meta: {
            'genkit.operation.type': 'embedding',
            'genkit.action.name': 'testEmbedder',
            'span.kind': 'client',
          },
        })

        await embedder({ input: [{ content: [{ text: 'hello' }] }] })
        await spanPromise
      })
    })
  })
})
