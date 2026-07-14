'use strict'

const assert = require('node:assert/strict')

const { trace } = require('@opentelemetry/api')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { preserveOtelContext } = require('../../dd-trace/src/opentelemetry/suppression')

describe('Plugin', () => {
  describe('genkit', () => {
    withVersions('genkit', ['@genkit-ai/core'], version => {
      let ai
      let runInNewSpan

      before(async () => {
        await agent.load('genkit')
        const { genkit } = require(`../../../versions/genkit@${version}`).get('genkit/beta')
        ;({ runInNewSpan } = require(`../../../versions/genkit@${version}`).get('@genkit-ai/core/tracing'))
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

      it('keeps one safe authoritative span when the OTel bridge is enabled', async () => {
        const embedder = ai.defineEmbedder({ name: 'safeOtelEmbedder' }, async documents => ({
          embeddings: documents.map(() => ({ embedding: [1, 2, 3] })),
        }))
        const tracesPromise = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.strictEqual(spans.length, 1)
          assert.strictEqual(spans[0].name, 'genkit.request')
          assert.strictEqual(spans[0].resource, 'safeOtelEmbedder')
          assert.strictEqual(spans[0].meta['genkit.operation.type'], 'embedding')

          const serialized = JSON.stringify({ meta: spans[0].meta, metrics: spans[0].metrics })
          assert.doesNotMatch(serialized, /genkit:input|genkit:output|\[1,2,3\]/)
        })

        await embedder({ input: [{ content: [{ text: 'safe input' }] }] })
        await tracesPromise
      })

      it('records an unrelated user OTel child under the authoritative Genkit span', async () => {
        if (process.env.DD_TRACE_OTEL_ENABLED !== 'true') return

        const userTracer = trace.getTracer('user-library')
        const model = ai.defineModel({ name: 'modelWithUserOtelChild' }, async () => {
          return userTracer.startActiveSpan('user.otel.child', span => {
            span.setAttribute('user.attribute', 'preserved')
            span.end()
            return {
              message: { role: 'model', content: [{ text: 'done' }] },
              finishReason: 'stop',
            }
          })
        })
        const tracesPromise = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.strictEqual(spans.length, 2)

          const genkitSpan = spans.find(span => span.name === 'genkit.request')
          const userSpan = spans.find(span => span.resource === 'user.otel.child')
          assert.ok(genkitSpan)
          assert.ok(userSpan)
          assert.strictEqual(userSpan.parent_id.toString(), genkitSpan.span_id.toString())
          assert.strictEqual(userSpan.meta['user.attribute'], 'preserved')
          assert.strictEqual(spans.some(span => span.meta['genkit:input'] !== undefined), false)
        })

        await model({ messages: [{ role: 'user', content: [{ text: 'hello' }] }] })
        await tracesPromise
      })

      it('does not leave OTel context preservation on an ambient user span', async () => {
        if (process.env.DD_TRACE_OTEL_ENABLED !== 'true') return

        const tracer = require('../../dd-trace')
        await tracer.trace('user-owned-parent', async span => {
          await runInNewSpan({
            metadata: { name: 'ignoredUtil' },
            labels: { 'genkit:type': 'util' },
          }, async () => {})

          assert.strictEqual(span[preserveOtelContext], undefined)
        })
      })
    })
  })
})
