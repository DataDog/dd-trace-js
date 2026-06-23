'use strict'

const assert = require('node:assert')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains, useEnv } = require('../../../integration-tests/helpers')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
  })

  withVersions('ai', 'ai', '>=7.0.0', (version) => {
    let ai
    let openai

    before(() => agent.load('ai'))

    after(() => agent.close())

    beforeEach(function () {
      ai = require(`../../../versions/ai@${version}`).get()

      const OpenAI = require('../../../versions/@ai-sdk/openai').get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai',
        compatibility: 'strict',
      })
    })

    it('creates spans for generateText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const generateTextSpan = spans.find(s => s.name === 'generateText')
        const stepSpan = spans.find(s => s.name === 'step')
        const languageModelCallSpan = spans.find(s => s.name === 'languageModelCall')

        assertObjectContains(generateTextSpan, {
          name: 'generateText',
          resource: 'generateText',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assert.ok(stepSpan, 'Expected step span to exist')

        assertObjectContains(languageModelCallSpan, {
          name: 'languageModelCall',
          resource: 'languageModelCall',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxOutputTokens: 100,
        temperature: 0.5,
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for embed', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const embedSpan = spans.find(s => s.name === 'embed')

        assertObjectContains(embedSpan, {
          name: 'embed',
          resource: 'embed',
          meta: {
            'ai.request.model': 'text-embedding-ada-002',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const result = await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world',
      })

      assert.ok(result.embedding, 'Expected result to be truthy')

      await checkTraces
    })

    // eslint-disable-next-line mocha/no-pending-tests
    it.skip('creates a span for embedMany', async () => { // TODO: it seems this was omitted from the change?
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const embedManySpan = spans.find(s => s.name === 'embedMany')

        assertObjectContains(embedManySpan, {
          name: 'embedMany',
          resource: 'embedMany',
          meta: {
            'ai.request.model': 'text-embedding-ada-002',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const result = await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world'],
      })

      assert.ok(result.embeddings, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates spans for streamText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const streamTextSpan = spans.find(s => s.name === 'streamText')
        const stepSpan = spans.find(s => s.name === 'step')
        const languageModelCallSpan = spans.find(s => s.name === 'languageModelCall')

        assertObjectContains(streamTextSpan, {
          name: 'streamText',
          resource: 'streamText',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assert.ok(stepSpan, 'Expected step span to exist')

        assertObjectContains(languageModelCallSpan, {
          name: 'languageModelCall',
          resource: 'languageModelCall',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxOutputTokens: 100,
        temperature: 0.5,
      })

      for await (const part of result.textStream) {} // eslint-disable-line

      await checkTraces
    })

    it('creates spans for a tool call', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const generateTextSpan = spans.find(s => s.name === 'generateText')
        const executeToolSpan = spans.find(s => s.name === 'executeTool')
        const languageModelCallSpans = spans.filter(s => s.name === 'languageModelCall')
        const stepSpans = spans.filter(s => s.name === 'step')

        assertObjectContains(generateTextSpan, {
          name: 'generateText',
          resource: 'generateText',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assert.strictEqual(stepSpans.length, 2, 'Expected two step spans (one per LLM turn)')
        assert.strictEqual(languageModelCallSpans.length, 2, 'Expected two languageModelCall spans')

        assert.ok(executeToolSpan, 'Expected executeTool span')
        assert.strictEqual(executeToolSpan.name, 'executeTool')
        assert.strictEqual(executeToolSpan.resource, 'executeTool')
      })

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools: {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: ai.jsonSchema({
              type: 'object',
              properties: {
                location: { type: 'string', description: 'The location to get the weather for' },
              },
              required: ['location'],
            }),
            execute: async ({ location }) => ({
              location,
              temperature: 72,
            }),
          }),
        },
        stopWhen: ai.stepCountIs(5),
        providerOptions: {
          openai: {
            store: false,
          },
        },
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates spans that respects the functionId', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const generateTextSpan = spans.find(s => s.name === 'generateText')
        const languageModelCallSpan = spans.find(s => s.name === 'languageModelCall')

        assertObjectContains(generateTextSpan, {
          name: 'generateText',
          resource: 'test',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(languageModelCallSpan, {
          name: 'languageModelCall',
          resource: 'test',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxOutputTokens: 100,
        temperature: 0.5,
        experimental_telemetry: {
          functionId: 'test',
        },
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })
  })
})
