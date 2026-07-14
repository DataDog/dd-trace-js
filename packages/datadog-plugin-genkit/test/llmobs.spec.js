'use strict'

const assert = require('node:assert/strict')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const {
  assertLlmObsSpanEvent,
  MOCK_NUMBER,
  MOCK_STRING,
  useLlmObs,
} = require('../../dd-trace/test/llmobs/util')

describe('genkit LLMObs', () => {
  const { getEvents } = useLlmObs({ plugin: 'genkit' })

  withVersions('genkit', ['@genkit-ai/core'], version => {
    let ai
    let runInNewSpan

    beforeEach(() => {
      const packages = require(`../../../versions/genkit@${version}`)
      const { genkit } = packages.get('genkit/beta')
      ;({ runInNewSpan } = packages.get('@genkit-ai/core/tracing'))
      ai = genkit({ name: 'datadog-genkit-llmobs-test' })
    })

    function findSpan (spans, name) {
      const span = spans.find(span => span.resource === name || span.name === name)
      assert.ok(span, `expected span ${name}; got ${spans.map(span => span.resource || span.name).join(', ')}`)
      return span
    }

    function findEvent (events, name) {
      const event = events.find(event => event.name === name)
      assert.ok(event, `expected LLMObs event ${name}`)
      return event
    }

    function expectedTags (span, error = false) {
      return {
        span,
        tags: { ml_app: 'test', integration: 'genkit' },
        ...(error && {
          error: {
            type: span.meta['error.type'],
            message: span.meta['error.message'],
            stack: MOCK_STRING,
          },
        }),
      }
    }

    it('normalizes model messages, tools, metrics, and allowlisted metadata', async () => {
      const model = ai.defineModel({ name: 'local/normalization-model' }, async request => ({
        message: {
          role: 'model',
          content: [
            { text: 'done' },
            { media: { url: 'https://example.invalid/secret' } },
            { custom: { excludedSecret: 'do-not-capture' } },
            { toolResponse: { name: 'weather', ref: 'weather-1', output: { temperature: 21 } } },
          ],
        },
        finishReason: 'stop',
        latencyMs: 12,
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, thoughtsTokens: 100 },
      }))

      await model({
        messages: [{
          role: 'user',
          content: [
            { text: 'weather?' },
            { toolRequest: { name: 'weather', ref: 'weather-1', input: { city: 'Paris' } } },
            { data: 'excluded-data' },
          ],
        }],
        config: { version: 'v1', temperature: 0.2, maxOutputTokens: 20, topK: 3, topP: 0.8, secret: 'excluded' },
        toolChoice: 'required',
      })

      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'local/normalization-model')
      const event = llmobsSpans[0]

      assertLlmObsSpanEvent(event, {
        ...expectedTags(span),
        spanKind: 'llm',
        name: 'local/normalization-model',
        modelName: 'local/normalization-model',
        modelProvider: 'custom',
        inputMessages: [{
          role: 'user',
          content: 'weather?',
          tool_calls: [{ name: 'weather', arguments: { city: 'Paris' }, tool_id: 'weather-1' }],
        }],
        outputMessages: [{
          role: 'assistant',
          content: 'done',
          tool_results: [{ name: 'weather', result: '{"temperature":21}', tool_id: 'weather-1' }],
        }],
        metrics: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        metadata: {
          version: 'v1',
          temperature: 0.2,
          max_output_tokens: 20,
          top_k: 3,
          top_p: 0.8,
          tool_choice: 'required',
          finish_reason: 'stop',
          latency_ms: MOCK_NUMBER,
        },
      })

      const serialized = JSON.stringify(event)
      assert.doesNotMatch(serialized, /do-not-capture|excluded-data|example\.invalid|thoughtsTokens/)
    })

    it('records model runner errors with input and an empty output', async () => {
      const model = ai.defineModel({ name: 'local/error-model' }, async () => {
        throw new Error('model runner failed')
      })

      await assert.rejects(
        model({ messages: [{ role: 'user', content: [{ text: 'fail' }] }] }),
        { message: 'model runner failed' }
      )

      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'local/error-model')
      assertLlmObsSpanEvent(llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'llm',
        name: 'local/error-model',
        modelName: 'local/error-model',
        modelProvider: 'custom',
        inputMessages: [{ role: 'user', content: 'fail' }],
        outputMessages: [{ role: '', content: '' }],
        metadata: {},
      })
    })

    it('finishes streaming model spans after chunks and the final response', async () => {
      const lifecycle = []
      const model = ai.defineModel({ name: 'local/stream-model' }, async (request, sendChunk) => {
        sendChunk({ content: [{ text: 'first' }] })
        lifecycle.push('first')
        await new Promise(resolve => setImmediate(resolve))
        sendChunk({ content: [{ text: 'second' }] })
        lifecycle.push('second')
        return {
          message: { role: 'model', content: [{ text: 'complete' }] },
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        }
      })

      const { stream, response } = ai.generateStream({ model, prompt: 'stream' })
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk.text)
      const result = await response
      lifecycle.push('response')

      assert.deepStrictEqual(chunks, ['first', 'second'])
      assert.strictEqual(result.text, 'complete')
      assert.deepStrictEqual(lifecycle, ['first', 'second', 'response'])

      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'local/stream-model')
      assertLlmObsSpanEvent(llmobsSpans[0], {
        ...expectedTags(span),
        spanKind: 'llm',
        name: 'local/stream-model',
        modelName: 'local/stream-model',
        modelProvider: 'custom',
        inputMessages: [{ role: 'user', content: 'stream' }],
        outputMessages: [{ role: 'assistant', content: 'complete' }],
        metrics: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        metadata: { finish_reason: 'stop', latency_ms: MOCK_NUMBER },
      })
    })

    it('records streaming model errors', async () => {
      const model = ai.defineModel({ name: 'local/stream-error-model' }, async () => {
        throw new Error('stream runner failed')
      })
      const { stream, response } = ai.generateStream({ model, prompt: 'fail stream' })

      await assert.rejects(async () => {
        for await (const chunk of stream) assert.fail(`unexpected chunk ${chunk.text}`)
        await response
      }, { message: 'stream runner failed' })

      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'local/stream-error-model')
      assertLlmObsSpanEvent(llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'llm',
        name: 'local/stream-error-model',
        modelName: 'local/stream-error-model',
        modelProvider: 'custom',
        inputMessages: [{ role: 'user', content: 'fail stream' }],
        outputMessages: [{ role: '', content: '' }],
        metadata: {},
      })
    })

    it('creates workflow spans for flows and named steps with correct parenting', async () => {
      const flow = ai.defineFlow({ name: 'parentFlow' }, input => {
        return ai.run('childStep', { input }, stepInput => ({ result: stepInput.input }))
      })

      await flow('hello')
      const { apmSpans, llmobsSpans } = await getEvents(2)
      const flowSpan = findSpan(apmSpans, 'parentFlow')
      const stepSpan = findSpan(apmSpans, 'childStep')
      const flowEvent = findEvent(llmobsSpans, 'parentFlow')
      const stepEvent = findEvent(llmobsSpans, 'childStep')

      assertLlmObsSpanEvent(flowEvent, {
        ...expectedTags(flowSpan),
        spanKind: 'workflow',
        name: 'parentFlow',
        inputValue: 'hello',
        outputValue: JSON.stringify({ result: 'hello' }),
        metadata: undefined,
      })
      assertLlmObsSpanEvent(stepEvent, {
        ...expectedTags(stepSpan),
        spanKind: 'workflow',
        name: 'childStep',
        inputValue: JSON.stringify({ input: 'hello' }),
        outputValue: JSON.stringify({ result: 'hello' }),
        parentId: flowEvent.span_id,
        metadata: undefined,
      })
      assert.strictEqual(stepSpan.parent_id.toString(), flowSpan.span_id.toString())
    })

    it('records workflow, flow-step, retrieval, and embedding runner errors', async () => {
      const failingFlow = ai.defineFlow({ name: 'failingFlow' }, async () => {
        throw new Error('flow runner failed')
      })
      await assert.rejects(failingFlow({ requested: true }), { message: 'flow runner failed' })

      let events = await getEvents()
      let span = findSpan(events.apmSpans, 'failingFlow')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'workflow',
        name: 'failingFlow',
        inputValue: JSON.stringify({ requested: true }),
        outputValue: '',
        metadata: undefined,
      })

      await assert.rejects(
        ai.run('failingStep', { requested: true }, async () => { throw new Error('step runner failed') }),
        { message: 'step runner failed' }
      )

      events = await getEvents()
      span = findSpan(events.apmSpans, 'failingStep')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'workflow',
        name: 'failingStep',
        inputValue: JSON.stringify({ requested: true }),
        outputValue: '',
        metadata: undefined,
      })

      const failingRetriever = ai.defineRetriever({ name: 'failingRetriever' }, async () => {
        throw new Error('retriever runner failed')
      })
      await assert.rejects(
        failingRetriever({ query: { content: [{ text: 'fail' }] } }),
        { message: 'retriever runner failed' }
      )

      events = await getEvents()
      span = findSpan(events.apmSpans, 'failingRetriever')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'retrieval',
        name: 'failingRetriever',
        inputValue: 'fail',
        metadata: undefined,
      })

      const failingEmbedder = ai.defineEmbedder({ name: 'failingEmbedder' }, async () => {
        throw new Error('embedder runner failed')
      })
      await assert.rejects(
        failingEmbedder({ input: [{ content: [{ text: 'fail' }] }] }),
        { message: 'embedder runner failed' }
      )

      events = await getEvents()
      span = findSpan(events.apmSpans, 'failingEmbedder')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'embedding',
        name: 'failingEmbedder',
        modelName: 'failingEmbedder',
        modelProvider: 'custom',
        inputDocuments: [{ text: 'fail' }],
        metadata: undefined,
      })
    })

    it('records tool success and runner errors', async () => {
      const tool = ai.defineTool({ name: 'weatherTool' }, async input => ({ city: input.city, temperature: 21 }))
      await tool({ city: 'Paris' })

      let events = await getEvents()
      let span = findSpan(events.apmSpans, 'weatherTool')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span),
        spanKind: 'tool',
        name: 'weatherTool',
        inputValue: JSON.stringify({ city: 'Paris' }),
        outputValue: JSON.stringify({ city: 'Paris', temperature: 21 }),
        metadata: undefined,
      })

      const failingTool = ai.defineTool({ name: 'failingTool' }, async () => {
        throw new Error('tool runner failed')
      })
      await assert.rejects(failingTool({ requested: true }), { message: 'tool runner failed' })

      events = await getEvents()
      span = findSpan(events.apmSpans, 'failingTool')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span, true),
        spanKind: 'tool',
        name: 'failingTool',
        inputValue: JSON.stringify({ requested: true }),
        outputValue: '',
        metadata: undefined,
      })
    })

    it('records tool interrupts as tool errors and the outer generation as successful', async () => {
      const interruptTool = ai.defineTool({ name: 'approvalRequired' }, async (input, { interrupt }) => {
        interrupt({ reason: 'approval required', input })
      })
      const model = ai.defineModel({ name: 'local/interrupt-model', supports: { tools: true } }, async () => ({
        message: {
          role: 'model',
          content: [{ toolRequest: { name: 'approvalRequired', ref: 'approval-1', input: { task: 'deploy' } } }],
        },
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }))

      const response = await ai.generate({ model, prompt: 'deploy', tools: [interruptTool], maxTurns: 1 })
      assert.strictEqual(response.finishReason, 'interrupted')

      const { apmSpans, llmobsSpans } = await getEvents(2)
      const modelSpan = findSpan(apmSpans, 'local/interrupt-model')
      const modelEvent = findEvent(llmobsSpans, 'local/interrupt-model')
      const toolEvent = findEvent(llmobsSpans, 'approvalRequired')

      assertLlmObsSpanEvent(modelEvent, {
        ...expectedTags(modelSpan),
        spanKind: 'llm',
        name: 'local/interrupt-model',
        modelName: 'local/interrupt-model',
        modelProvider: 'custom',
        inputMessages: [{ role: 'user', content: 'deploy' }],
        outputMessages: [{
          role: 'assistant',
          tool_calls: [{ name: 'approvalRequired', arguments: { task: 'deploy' }, tool_id: 'approval-1' }],
        }],
        metrics: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        metadata: { finish_reason: 'stop', latency_ms: MOCK_NUMBER },
      })
      assert.strictEqual(toolEvent.meta['span.kind'], 'tool')
      assert.strictEqual(toolEvent.status, 'error')
      assert.strictEqual(toolEvent.meta.input.value, JSON.stringify({ task: 'deploy' }))
      assert.strictEqual(toolEvent.meta.output.value, undefined)
      assert.strictEqual(toolEvent.meta['error.type'], 'ToolInterruptError')
      assert.strictEqual(toolEvent.meta['error.message'], undefined)
      assert.ok(toolEvent.tags.includes('error:1'))
      assert.ok(toolEvent.tags.includes('integration:genkit'))
    })

    it('normalizes retrieval documents and allowlists reviewed metadata', async () => {
      const retriever = ai.defineRetriever({ name: 'localRetriever' }, async query => ({
        documents: [{
          content: [{ text: `result:${query.text}` }, { media: { url: 'https://example.invalid/excluded-media' } }],
          metadata: { name: 'doc', id: 'doc-1', score: 0.9, excludedSecret: 'do-not-capture' },
        }],
      }))

      await retriever({
        query: { content: [{ text: 'search' }, { media: { url: 'https://example.invalid/excluded-query' } }] },
      })
      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'localRetriever')
      const event = llmobsSpans[0]
      assertLlmObsSpanEvent(event, {
        ...expectedTags(span),
        spanKind: 'retrieval',
        name: 'localRetriever',
        inputValue: 'search',
        outputDocuments: [{ text: 'result:search', name: 'doc', id: 'doc-1', score: 0.9 }],
        metadata: undefined,
      })
      assert.doesNotMatch(JSON.stringify(event), /do-not-capture|excluded-query|excluded-media/)
    })

    it('summarizes embedding vectors without recording vector values or arbitrary metadata', async () => {
      const embedder = ai.defineEmbedder({ name: 'localEmbedder' }, async documents => ({
        embeddings: documents.map((document, index) => ({
          embedding: [index + 0.12345, index + 0.23456, index + 0.34567],
          metadata: { excludedSecret: 'do-not-capture' },
        })),
      }))

      await embedder({
        input: [
          { content: [{ text: 'first' }], metadata: { name: 'one', id: '1', excludedSecret: 'secret' } },
          { content: [{ text: 'second' }], metadata: { name: 'two', id: '2' } },
        ],
      })
      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'localEmbedder')
      const event = llmobsSpans[0]
      assertLlmObsSpanEvent(event, {
        ...expectedTags(span),
        spanKind: 'embedding',
        name: 'localEmbedder',
        modelName: 'localEmbedder',
        modelProvider: 'custom',
        inputDocuments: [
          { text: 'first', name: 'one', id: '1' },
          { text: 'second', name: 'two', id: '2' },
        ],
        outputValue: '[2 embedding(s) returned with size 3]',
        metadata: undefined,
      })
      assert.doesNotMatch(JSON.stringify(event), /0\.12345|0\.23456|0\.34567|do-not-capture|secret/)
    })

    it('demotes models owned by an enabled provider integration without duplicate metrics', async () => {
      const pluginManager = require('../../..')._pluginManager
      const previousPlugin = pluginManager._pluginsByName['google-genai']
      pluginManager._pluginsByName['google-genai'] = { llmobs: { _enabled: true } }

      try {
        const model = ai.defineModel({ name: 'googleai/provider-model' }, async () => ({
          message: { role: 'model', content: [{ text: 'provider response' }] },
          finishReason: 'stop',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        }))

        await model({ messages: [{ role: 'user', content: [{ text: 'provider input' }] }] })

        const { llmobsSpans } = await getEvents()
        const event = findEvent(llmobsSpans, 'googleai/provider-model')
        assert.strictEqual(event.meta['span.kind'], 'workflow')
        assert.strictEqual(event.meta.input.value, JSON.stringify({
          messages: [{ role: 'user', content: [{ text: 'provider input' }] }],
        }))
        const output = JSON.parse(event.meta.output.value)
        assert.deepStrictEqual({
          message: output.message,
          finishReason: output.finishReason,
          usage: output.usage,
        }, {
          message: { role: 'model', content: [{ text: 'provider response' }] },
          finishReason: 'stop',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        })
        assert.strictEqual(typeof output.latencyMs, 'number')
        assert.deepStrictEqual(event.metrics, {})
      } finally {
        if (previousPlugin === undefined) {
          delete pluginManager._pluginsByName['google-genai']
        } else {
          pluginManager._pluginsByName['google-genai'] = previousPlugin
        }
      }
    })

    it('keeps googleai models authoritative when the provider integration is disabled', async () => {
      const pluginManager = require('../../..')._pluginManager
      const previousPlugin = pluginManager._pluginsByName['google-genai']
      pluginManager._pluginsByName['google-genai'] = { llmobs: { _enabled: false } }

      try {
        const model = ai.defineModel({ name: 'googleai/unowned-model' }, async () => ({
          message: { role: 'model', content: [{ text: 'owned by Genkit' }] },
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        }))

        await model({ messages: [{ role: 'user', content: [{ text: 'hello' }] }] })

        const { apmSpans, llmobsSpans } = await getEvents()
        const span = findSpan(apmSpans, 'googleai/unowned-model')
        assertLlmObsSpanEvent(llmobsSpans[0], {
          ...expectedTags(span),
          spanKind: 'llm',
          name: 'googleai/unowned-model',
          modelName: 'googleai/unowned-model',
          modelProvider: 'google',
          inputMessages: [{ role: 'user', content: 'hello' }],
          outputMessages: [{ role: 'assistant', content: 'owned by Genkit' }],
          metrics: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          metadata: { finish_reason: 'stop', latency_ms: MOCK_NUMBER },
        })
      } finally {
        if (previousPlugin === undefined) {
          delete pluginManager._pluginsByName['google-genai']
        } else {
          pluginManager._pluginsByName['google-genai'] = previousPlugin
        }
      }
    })

    it('preserves selected parenting through ignored native labels', async () => {
      const tool = ai.defineTool({ name: 'nestedTool' }, async input => input)
      const flow = ai.defineFlow({ name: 'ignoredParentFlow' }, async () => {
        return runInNewSpan({
          metadata: { name: 'ignoredUtil' },
          labels: { 'genkit:type': 'util' },
        }, () => tool({ nested: true }))
      })

      await flow()
      const { apmSpans, llmobsSpans } = await getEvents(2)
      const flowSpan = findSpan(apmSpans, 'ignoredParentFlow')
      const toolSpan = findSpan(apmSpans, 'nestedTool')
      const flowEvent = findEvent(llmobsSpans, 'ignoredParentFlow')
      const toolEvent = findEvent(llmobsSpans, 'nestedTool')

      assert.strictEqual(llmobsSpans.some(span => span.name === 'ignoredUtil'), false)
      assert.strictEqual(toolSpan.parent_id.toString(), flowSpan.span_id.toString())
      assert.strictEqual(toolEvent.parent_id, flowEvent.span_id)
    })

    it('uses serialized output fallback and ignores malformed fallback JSON', async () => {
      const validOptions = {
        metadata: { name: 'fallbackTool' },
        labels: { 'genkit:metadata:subtype': 'tool' },
      }
      await runInNewSpan(validOptions, metadata => {
        metadata.input = { value: 'input' }
        metadata.output = JSON.stringify({ value: 'fallback' })
      })

      let events = await getEvents()
      let span = findSpan(events.apmSpans, 'fallbackTool')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span),
        spanKind: 'tool',
        name: 'fallbackTool',
        inputValue: JSON.stringify({ value: 'input' }),
        outputValue: JSON.stringify({ value: 'fallback' }),
        metadata: undefined,
      })

      const malformedOptions = {
        metadata: { name: 'malformedFallbackTool' },
        labels: { 'genkit:metadata:subtype': 'tool' },
      }
      await runInNewSpan(malformedOptions, metadata => {
        metadata.input = 'input'
        metadata.output = '{invalid'
      })

      events = await getEvents()
      span = findSpan(events.apmSpans, 'malformedFallbackTool')
      assertLlmObsSpanEvent(events.llmobsSpans[0], {
        ...expectedTags(span),
        spanKind: 'tool',
        name: 'malformedFallbackTool',
        inputValue: 'input',
        metadata: undefined,
      })
    })

    it('extracts options from the three-argument runInNewSpan overload', async () => {
      const options = {
        metadata: { name: 'threeArgumentTool' },
        labels: { 'genkit:metadata:subtype': 'tool' },
      }
      await runInNewSpan({}, options, metadata => {
        metadata.input = { overload: 3 }
        return { accepted: true }
      })

      const { apmSpans, llmobsSpans } = await getEvents()
      const span = findSpan(apmSpans, 'threeArgumentTool')
      assertLlmObsSpanEvent(llmobsSpans[0], {
        ...expectedTags(span),
        spanKind: 'tool',
        name: 'threeArgumentTool',
        inputValue: JSON.stringify({ overload: 3 }),
        outputValue: JSON.stringify({ accepted: true }),
        metadata: undefined,
      })
    })
  })
})
