'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')
const assert = require('node:assert')
const semifies = require('semifies')

const { NODE_MAJOR } = require('../../../version')

// ai<4.0.2 is not supported in CommonJS with Node.js < 22
const range = NODE_MAJOR < 22 ? '>=4.0.2' : '>=4.0.0'

function getAiSdkOpenAiPackage (vercelAiVersion) {
  return semifies(vercelAiVersion, '>=5.0.0') ? '@ai-sdk/openai' : '@ai-sdk/openai@1.3.23'
}

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>'
  })

  withVersions('ai', 'ai', range, (version, _, realVersion) => {
    let ai
    let openai

    before(() => agent.load('ai'))

    after(() => agent.close({ ritmReset: false }))

    beforeEach(function () {
      ai = require(`../../../versions/ai@${version}`).get()

      const OpenAI = require(`../../../versions/${getAiSdkOpenAiPackage(realVersion)}`).get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai',
        compatibility: 'strict'
      })
    })

    it('creates a span for generateText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const generateTextSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]

        assert.strictEqual(generateTextSpan.name, 'ai.generateText')
        assert.strictEqual(generateTextSpan.resource, 'ai.generateText')
        assert.strictEqual(generateTextSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(generateTextSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doGenerateSpan.name, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.resource, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
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
        assert.strictEqual(generateObjectSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(generateObjectSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doGenerateSpan.name, 'ai.generateObject.doGenerate')
        assert.strictEqual(doGenerateSpan.resource, 'ai.generateObject.doGenerate')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model_provider'], 'openai')
      })

      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' }
        },
        required: ['name', 'age', 'height']
      })

      const result = await ai.generateObject({
        model: openai('gpt-4o-mini'),
        schema,
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
        assert.strictEqual(streamTextSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(streamTextSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doStreamSpan.name, 'ai.streamText.doStream')
        assert.strictEqual(doStreamSpan.resource, 'ai.streamText.doStream')
        assert.strictEqual(doStreamSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(doStreamSpan.meta['ai.request.model_provider'], 'openai')
      })

      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
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
        assert.strictEqual(streamObjectSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(streamObjectSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doStreamSpan.name, 'ai.streamObject.doStream')
        assert.strictEqual(doStreamSpan.resource, 'ai.streamObject.doStream')
        assert.strictEqual(doStreamSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(doStreamSpan.meta['ai.request.model_provider'], 'openai')
      })

      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' }
        },
        required: ['name', 'age', 'height']
      })

      const result = await ai.streamObject({
        model: openai('gpt-4o-mini'),
        schema,
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
        assert.strictEqual(toolCallSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(toolCallSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(doGenerateSpan.name, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.resource, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(doGenerateSpan.meta['ai.request.model_provider'], 'openai')

        assert.strictEqual(toolCallSpan2.name, 'ai.toolCall')
        assert.strictEqual(toolCallSpan2.resource, 'ai.toolCall')

        assert.strictEqual(doGenerateSpan2.name, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan2.resource, 'ai.generateText.doGenerate')
        assert.strictEqual(doGenerateSpan2.meta['ai.request.model'], 'gpt-4o-mini')
        assert.strictEqual(doGenerateSpan2.meta['ai.request.model_provider'], 'openai')
      })

      let tools
      let maxStepsArg = {}
      const toolSchema = ai.jsonSchema({
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The location to get the weather for' }
        },
        required: ['location']
      })
      if (semifies(realVersion, '>=5.0.0')) {
        tools = {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: toolSchema,
            execute: async ({ location }) => ({
              location,
              temperature: 72
            })
          })
        }

        maxStepsArg = { stopWhen: ai.stepCountIs(5) }
      } else {
        tools = [ai.tool({
          id: 'weather',
          description: 'Get the weather in a given location',
          parameters: toolSchema,
          execute: async ({ location }) => ({
            location,
            temperature: 72
          })
        })]

        maxStepsArg = { maxSteps: 5 }
      }

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...maxStepsArg,
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })
  })
})
