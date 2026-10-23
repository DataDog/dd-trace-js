'use strict'

const assert = require('node:assert')
const Module = require('node:module')
const { after, describe, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_NUMBER,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

const OPENAI_BASE_URL = 'http://127.0.0.1:9126/vcr/openai'

/**
 * @typedef {{
 *   getQueryEmbedding: (query: object) => Promise<unknown>,
 *   getTextEmbeddingsBatch: (texts: string[]) => Promise<unknown>
 * }} EmbeddingApi
 */

function loadCore (version, moduleName) {
  return require(`../../../../../../versions/@llamaindex/core@${version}`).get(moduleName)
}

function loadOpenAI () {
  return require('../../../../../../versions/@llamaindex/openai@0.4.0').get()
}

function createLLM (OpenAI, options = {}) {
  return new OpenAI({
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL,
    temperature: 0,
    ...options,
  })
}

function findSpan (spans, name) {
  const span = spans.find(item => item.name === name)
  assert.ok(span, `expected ${name} span`)
  return span
}

describe('integrations', () => {
  describe('with the OpenAI provider integration enabled', () => {
    // @ts-expect-error -- useLlmObs accepts multiple plugins at runtime
    const { getEvents } = useLlmObs({ plugin: ['llamaindex', 'openai'], tracerConfigOptions: {} })

    after(() => {
      // @ts-expect-error -- plugin manager is an internal tracer property
      require('../../../../../..')._pluginManager._pluginsByName.openai.configure({ enabled: false })
    })

    withVersions('llamaindex', '@llamaindex/core', version => {
      it('demotes the LlamaIndex span and emits one provider LLM span', async () => {
        const openaiRequire = Module.createRequire(
          `${process.cwd()}/versions/@llamaindex/openai@0.4.0/node_modules/openai/package.json`
        )
        const { OpenAI: OpenAISession } = openaiRequire('openai')
        const session = new OpenAISession({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: OPENAI_BASE_URL,
        })
        const { OpenAI } = loadOpenAI()
        await createLLM(OpenAI, { session }).chat({ messages: [{ role: 'user', content: 'Hello, OpenAI!' }] })

        const { apmSpans, llmobsSpans } = await getEvents(2)
        assert.ok(apmSpans.some(span => span.name === 'openai.request'))
        assert.equal(llmobsSpans.filter(span => span.meta['span.kind'] === 'llm').length, 1)
        assert.equal(findSpan(llmobsSpans, 'OpenAI.chat').meta['span.kind'], 'workflow')
        assert.ok(llmobsSpans.some(span => span.name === 'OpenAI.createChatCompletion'))
      })
    })
  })

  describe('llamaindex', () => {
    const { getEvents } = useLlmObs({ plugin: 'llamaindex', tracerConfigOptions: {} })

    withVersions('llamaindex', '@llamaindex/core', version => {
      it('submits a non-streaming LLM span', async () => {
        const { OpenAI } = loadOpenAI()
        await createLLM(OpenAI).chat({ messages: [{ role: 'user', content: 'Hello, OpenAI!' }] })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(findSpan(llmobsSpans, 'OpenAI.chat'), {
          span: findSpan(apmSpans, 'llamaindex.request'),
          spanKind: 'llm',
          modelName: 'gpt-4o-mini',
          modelProvider: 'openai',
          name: 'OpenAI.chat',
          inputMessages: [{ role: 'user', content: 'Hello, OpenAI!' }],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
          },
          metadata: { temperature: 0 },
          tags: { ml_app: 'test', integration: 'llamaindex' },
        })
      })

      it('normalizes complete prompts into user messages', async () => {
        const { OpenAI } = loadOpenAI()
        await createLLM(OpenAI).complete({ prompt: 'Complete this sentence.' })

        const { llmobsSpans } = await getEvents()
        assert.deepEqual(findSpan(llmobsSpans, 'OpenAI.chat').meta.input.messages, [{
          role: 'user',
          content: 'Complete this sentence.',
        }])
      })

      it('keeps streaming LLM spans open through iteration', async () => {
        const { OpenAI } = loadOpenAI()
        let output = ''
        for await (const chunk of await createLLM(OpenAI, {
          additionalChatOptions: { stream_options: { include_usage: true } },
        }).chat({
          messages: [{ role: 'user', content: 'Stream a response.' }],
          stream: true,
        })) {
          output += chunk.delta
        }
        assert.equal(output, 'LlamaIndex stream response.')

        const { apmSpans, llmobsSpans } = await getEvents()
        const span = findSpan(llmobsSpans, 'OpenAI.chat')
        assert.equal(JSON.stringify(span.meta.output.messages).includes('LlamaIndex stream response.'), true)
        assert.equal(apmSpans.filter(item => item.resource === 'OpenAI.chat').length, 1)
      })

      it('extracts every tool call from an LLM response', async () => {
        const { OpenAI } = loadOpenAI()
        const { FunctionTool } = loadCore(version, '@llamaindex/core/tools')
        const tool = new FunctionTool(() => 'Paris', {
          name: 'weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        })
        await createLLM(OpenAI).chat({
          messages: [{ role: 'user', content: 'What is the weather?' }],
          tools: [tool],
        })

        const { llmobsSpans } = await getEvents()
        const output = findSpan(llmobsSpans, 'OpenAI.chat').meta.output.messages[0]
        assert.deepEqual(output.tool_calls, [{
          name: 'weather',
          arguments: { city: 'Paris' },
          tool_id: 'call_llamaindex',
        }])
      })

      it('submits query and batch embedding spans', async () => {
        const { OpenAIEmbedding } = loadOpenAI()
        const embedding = new OpenAIEmbedding({
          model: 'text-embedding-ada-002',
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: OPENAI_BASE_URL,
        })
        const embeddingApi = /** @type {EmbeddingApi} */ (/** @type {unknown} */ (embedding))
        await embeddingApi.getQueryEmbedding({ type: 'text', text: 'hello' })
        const queryEvents = await getEvents()
        await embeddingApi.getTextEmbeddingsBatch(['a', 'b'])
        const batchEvents = await getEvents()

        const querySpan = findSpan(queryEvents.llmobsSpans, 'OpenAIEmbedding.getQueryEmbedding')
        assertLlmObsSpanEvent(querySpan, {
          span: queryEvents.apmSpans.find(item => item.resource === 'OpenAIEmbedding.getQueryEmbedding'),
          spanKind: 'embedding',
          modelName: 'text-embedding-ada-002',
          modelProvider: 'openai',
          name: 'OpenAIEmbedding.getQueryEmbedding',
          inputDocuments: [{ text: 'hello' }],
          outputValue: '[1 embedding(s) returned with size 1536]',
          tags: { ml_app: 'test', integration: 'llamaindex' },
        })
        const embeddingSpans = batchEvents.llmobsSpans.filter(item => item.meta['span.kind'] === 'embedding')
        assert.equal(embeddingSpans.length, 1)
        const { apmSpans } = batchEvents
        assertLlmObsSpanEvent(embeddingSpans[0], {
          span: apmSpans.find(item => item.resource === 'OpenAIEmbedding.getTextEmbeddingsBatch'),
          spanKind: 'embedding',
          modelName: 'text-embedding-ada-002',
          modelProvider: 'openai',
          name: 'OpenAIEmbedding.getTextEmbeddingsBatch',
          inputDocuments: [{ text: 'a' }, { text: 'b' }],
          outputValue: '[2 embedding(s) returned with size 1536]',
          tags: { ml_app: 'test', integration: 'llamaindex' },
        })
      })

      it('submits retrieval documents', async () => {
        const { BaseRetriever } = loadCore(version, '@llamaindex/core/retriever')
        const { TextNode } = loadCore(version, '@llamaindex/core/schema')

        class TestRetriever extends BaseRetriever {
          async _retrieve () {
            return [{ node: new TextNode({ text: 'document' }), score: 0.9 }]
          }
        }

        await new TestRetriever().retrieve('hello')
        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(findSpan(llmobsSpans, 'TestRetriever.retrieve'), {
          span: apmSpans.find(item => item.resource === 'TestRetriever.retrieve'),
          spanKind: 'retrieval',
          name: 'TestRetriever.retrieve',
          inputValue: 'hello',
          outputDocuments: [{ text: 'document', score: MOCK_NUMBER, id: MOCK_STRING }],
          tags: { ml_app: 'test', integration: 'llamaindex' },
        })
      })

      it('preserves query, retrieval, synthesize, and child LLM relationships', async () => {
        const { OpenAI } = loadOpenAI()
        const { BaseRetriever } = loadCore(version, '@llamaindex/core/retriever')
        const { TextNode } = loadCore(version, '@llamaindex/core/schema')
        const { RetrieverQueryEngine } = loadCore(version, '@llamaindex/core/query-engine')
        const { getResponseSynthesizer } = loadCore(version, '@llamaindex/core/response-synthesizers')

        class TestRetriever extends BaseRetriever {
          async _retrieve () {
            return [{ node: new TextNode({ text: 'document' }), score: 0.9 }]
          }
        }

        const synthesizer = getResponseSynthesizer('compact', { llm: createLLM(OpenAI) })
        await new RetrieverQueryEngine(new TestRetriever(), synthesizer).query({ query: 'Summarize this.' })

        const { llmobsSpans } = await getEvents(4)
        const query = findSpan(llmobsSpans, 'RetrieverQueryEngine.query')
        const retrieval = findSpan(llmobsSpans, 'TestRetriever.retrieve')
        const synthesize = findSpan(llmobsSpans, 'CompactAndRefine.synthesize')
        const childLLM = findSpan(llmobsSpans, 'OpenAI.chat')
        assert.equal(retrieval.parent_id, query.span_id)
        assert.equal(synthesize.parent_id, query.span_id)
        assert.equal(childLLM.parent_id, synthesize.span_id)
        assert.ok(query.start_ns <= retrieval.start_ns)
        assert.ok(retrieval.start_ns <= synthesize.start_ns)
      })

      it('records an empty output for an OpenAI error', async () => {
        const { OpenAI } = loadOpenAI()
        await assert.rejects(createLLM(OpenAI, { model: 'llamaindex-error' }).chat({
          messages: [{ role: 'user', content: 'fail' }],
        }))

        const { llmobsSpans } = await getEvents()
        const span = findSpan(llmobsSpans, 'OpenAI.chat')
        assert.ok(span.tags.includes('error:1'))
        assert.deepEqual(span.meta.output.messages, [{ role: '', content: '' }])
      })
    })
  })
})
