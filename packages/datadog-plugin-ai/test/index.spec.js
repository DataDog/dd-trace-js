'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')
const assert = require('node:assert')

const semifies = require('semifies')

const { NODE_MAJOR } = require('../../../version')

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>'
  })

  withVersions('ai', 'ai', version => {
    let ai
    let openai
    let zod

    before(() => agent.load('ai'))

    after(() => agent.close({ ritmReset: false }))

    beforeEach(function () {
      const mod = require(`../../../versions/ai@${version}`)
      const moduleVersion = mod.version()

      if (semifies(moduleVersion, '<4.0.2') && NODE_MAJOR < 22) {
        /**
         * Resolves the following error:
         *
         * Error [ERR_REQUIRE_ESM]: require() of ES Module  from ... not supported.
         */
        this.skip()
      }

      ai = mod.get()

      const OpenAI = require('../../../versions/@ai-sdk/openai').get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai'
      })

      zod = require('../../../versions/zod').get()
    })

    it('creates a span for generateText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const generateTextSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]

        assert.strictEqual(generateTextSpan.name, 'ai.generateText')
        assert.strictEqual(generateTextSpan.resource, 'ai.generateText')
        assert.strictEqual(generateTextSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(generateTextSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doGenerateSpan.name, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.resource, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.generateText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for generateObject', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const generateObjectSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]

        assert.strictEqual(generateObjectSpan.name, 'ai.generateObject')
        assert.strictEqual(generateObjectSpan.resource, 'ai.generateObject')
        assert.strictEqual(generateObjectSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(generateObjectSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doGenerateSpan.name, 'ai.generateObject.doGenerate')
        assert.strictEqual(doGenerateSpan.resource, 'ai.generateObject.doGenerate')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.generateObject({
        model: openai('gpt-3.5-turbo'),
        schema: zod.object({
          name: zod.string(),
          age: zod.number(),
          height: zod.string()
        }),
        prompt: 'Invent a character for a video game'
      })

      assert.ok(result.object, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for embed', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const embedSpan = traces[0][0]
        const doEmbedSpan = traces[0][1]

        assert.strictEqual(embedSpan.name, 'ai.embed')
        assert.strictEqual(embedSpan.resource, 'ai.embed')
        assert.strictEqual(embedSpan.meta['ai.request.model'], 'text-embedding-ada-002')
        assert.strictEqual(embedSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doEmbedSpan.name, 'ai.embed.doEmbed')
        assert.strictEqual(doEmbedSpan.resource, 'ai.embed.doEmbed')
        assert.strictEqual(doEmbedSpan.meta['ai.request.model'], 'text-embedding-ada-002')
        assert.strictEqual(doEmbedSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world'
      })

      assert.ok(result.embedding, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for embedMany', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const embedManySpan = traces[0][0]
        const doEmbedSpan = traces[0][1]

        assert.strictEqual(embedManySpan.name, 'ai.embedMany')
        assert.strictEqual(embedManySpan.resource, 'ai.embedMany')
        assert.strictEqual(embedManySpan.meta['ai.request.model'], 'text-embedding-ada-002')
        assert.strictEqual(embedManySpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doEmbedSpan.name, 'ai.embedMany.doEmbed')
        assert.strictEqual(doEmbedSpan.resource, 'ai.embedMany.doEmbed')
        assert.strictEqual(doEmbedSpan.meta['ai.request.model'], 'text-embedding-ada-002')
        assert.strictEqual(doEmbedSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world']
      })

      assert.ok(result.embeddings, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for streamText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const streamTextSpan = traces[0][0]
        const doStreamSpan = traces[0][1]

        assert.strictEqual(streamTextSpan.name, 'ai.streamText')
        assert.strictEqual(streamTextSpan.resource, 'ai.streamText')
        assert.strictEqual(streamTextSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(streamTextSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doStreamSpan.name, 'ai.streamText.doStream')
        assert.strictEqual(doStreamSpan.resource, 'ai.streamText.doStream')
        assert.strictEqual(doStreamSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(doStreamSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.streamText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      const textStream = result.textStream

      assert.ok(textStream, 'Expected result to be truthy')

      for await (const part of textStream) {
        assert.ok(part, 'Expected part to be truthy')
      }

      await checkTraces
    })

    it('creates a span for streamObject', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const streamObjectSpan = traces[0][0]
        const doStreamSpan = traces[0][1]

        assert.strictEqual(streamObjectSpan.name, 'ai.streamObject')
        assert.strictEqual(streamObjectSpan.resource, 'ai.streamObject')
        assert.strictEqual(streamObjectSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(streamObjectSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doStreamSpan.name, 'ai.streamObject.doStream')
        assert.strictEqual(doStreamSpan.resource, 'ai.streamObject.doStream')
        assert.strictEqual(doStreamSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(doStreamSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.streamObject({
        model: openai('gpt-3.5-turbo'),
        schema: zod.object({
          name: zod.string(),
          age: zod.number(),
          height: zod.string()
        }),
        prompt: 'Invent a character for a video game'
      })

      const partialObjectStream = result.partialObjectStream

      assert.ok(partialObjectStream, 'Expected result to be truthy')

      for await (const part of partialObjectStream) {
        assert.ok(part, 'Expected part to be truthy')
      }

      await checkTraces
    })

    it('creates a span for a tool call', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const toolCallSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]
        const toolCallSpan2 = traces[0][2]
        const doGenerateSpan2 = traces[0][3]

        assert.strictEqual(toolCallSpan.name, 'ai.generateText')
        assert.strictEqual(toolCallSpan.resource, 'ai.generateText')
        assert.strictEqual(toolCallSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(toolCallSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doGenerateSpan.name, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.resource, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(toolCallSpan2.name, 'ai.toolCall')
        assert.strictEqual(toolCallSpan2.resource, 'ai.toolCall')

        assert.strictEqual(doGenerateSpan2.name, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan2.resource, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan2.meta['ai.request.model'], 'gpt-3.5-turbo')
        assert.strictEqual(doGenerateSpan2.meta['ai.request.model_provider'], 'openai')
      })

      const getWeather = ai.tool({
        id: 'get_weather',
        description: 'Get the weather in a given location',
        parameters: zod.object({
          location: zod.string()
        }),
        execute: async ({ location }) => `It is nice and sunny in ${location}.`
      })

      const result = await ai.generateText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools: [getWeather],
        maxSteps: 2,
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })
  })
})
