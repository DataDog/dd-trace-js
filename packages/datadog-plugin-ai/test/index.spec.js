'use strict'

const assert = require('node:assert')
const semifies = require('semifies')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains, useEnv } = require('../../../integration-tests/helpers')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const { NODE_MAJOR } = require('../../../version')

// ai<4.0.2 is not supported in CommonJS with Node.js < 22
const range = NODE_MAJOR < 22 ? '>=4.0.2' : '>=4.0.0'

function getAiSdkOpenAiPackage (vercelAiVersion) {
  if (semifies(vercelAiVersion, '>=6.0.0')) {
    return '@ai-sdk/openai'
  } else if (semifies(vercelAiVersion, '>=5.0.0')) {
    return '@ai-sdk/openai@2.0.0'
  } else {
    return '@ai-sdk/openai@1.3.23'
  }
}

// making a different reference from the default no-op tracer in the instrumentation
// attempted to use the DD tracer provider, but it double-traces the request
// in practice, there is no need to pass in the DD OTel tracer provider, so this
// case shouldn't be an issue in practice
const myTracer = {
  startActiveSpan () {
    const fn = arguments[arguments.length - 1]

    const span = {
      spanContext () { return { traceId: '', spanId: '', traceFlags: 0 } },
      setAttribute () { return this },
      setAttributes () { return this },
      addEvent () { return this },
      addLink () { return this },
      addLinks () { return this },
      setStatus () { return this },
      updateName () { return this },
      end () { return this },
      isRecording () { return false },
      recordException () { return this },
    }

    return fn(span)
  },
}

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
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
        compatibility: 'strict',
      })
    })

    describe('patching behavior with experimental_telemetry options', () => {
      it('should not error when `isEnabled` is false', async () => {
        const experimentalTelemetry = { isEnabled: false }
        const result = await ai.generateText({
          model: openai('gpt-4o-mini'),
          system: 'You are a helpful assistant',
          prompt: 'Hello, OpenAI!',
          maxTokens: 100,
          temperature: 0.5,
          experimental_telemetry: experimentalTelemetry,
        })

        assert.ok(result.text, 'Expected result to be truthy')
        assert.ok(experimentalTelemetry.tracer == null, 'Tracer should not be set by default')
      })

      it('should not error when a `tracer` is not passed in', async () => {
        const checkTraces = agent.assertSomeTraces(traces => {
          const generateTextSpan = traces[0][0]
          const doGenerateSpan = traces[0][1]

          assertObjectContains(generateTextSpan, {
            name: 'ai.generateText',
            resource: 'ai.generateText',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'ai.request.model_provider': 'openai',
            },
          })

          assertObjectContains(doGenerateSpan, {
            name: 'ai.generateText.doGenerate',
            resource: 'ai.generateText.doGenerate',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'ai.request.model_provider': 'openai',
            },
          })
        })

        const experimentalTelemetry = { isEnabled: true }

        const result = await ai.generateText({
          model: openai('gpt-4o-mini'),
          system: 'You are a helpful assistant',
          prompt: 'Hello, OpenAI!',
          maxTokens: 100,
          temperature: 0.5,
          experimental_telemetry: experimentalTelemetry,
        })

        assert.ok(result.text, 'Expected result to be truthy')

        await checkTraces
      })

      it('should not error when only a `tracer` is not passed in', async () => {
        const checkTraces = agent.assertSomeTraces(traces => {
          const generateTextSpan = traces[0][0]
          const doGenerateSpan = traces[0][1]

          assertObjectContains(generateTextSpan, {
            name: 'ai.generateText',
            resource: 'ai.generateText',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'ai.request.model_provider': 'openai',
            },
          })

          assertObjectContains(doGenerateSpan, {
            name: 'ai.generateText.doGenerate',
            resource: 'ai.generateText.doGenerate',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'ai.request.model_provider': 'openai',
            },
          })
        })

        const experimentalTelemetry = { tracer: myTracer }

        const result = await ai.generateText({
          model: openai('gpt-4o-mini'),
          system: 'You are a helpful assistant',
          prompt: 'Hello, OpenAI!',
          maxTokens: 100,
          temperature: 0.5,
          experimental_telemetry: experimentalTelemetry,
        })

        assert.ok(result.text, 'Expected result to be truthy')
        assert.ok(experimentalTelemetry.tracer === myTracer, 'Tracer should be set when `isEnabled` is true')

        await checkTraces
      })

      it('should use the passed in `tracer`', async () => {
        const checkTraces = agent.assertSomeTraces(traces => {
          const generateTextSpan = traces[0][0]
          const doGenerateSpan = traces[0][1]

          assertObjectContains(generateTextSpan, {
            name: 'ai.generateText',
            resource: 'ai.generateText',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'ai.request.model_provider': 'openai',
            },
          })

          assertObjectContains(doGenerateSpan, {
            name: 'ai.generateText.doGenerate',
            resource: 'ai.generateText.doGenerate',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'ai.request.model_provider': 'openai',
            },
          })
        })

        const experimentalTelemetry = { isEnabled: true, tracer: myTracer }

        const result = await ai.generateText({
          model: openai('gpt-4o-mini'),
          system: 'You are a helpful assistant',
          prompt: 'Hello, OpenAI!',
          maxTokens: 100,
          temperature: 0.5,
          experimental_telemetry: experimentalTelemetry,
        })

        assert.ok(result.text, 'Expected result to be truthy')
        assert.ok(experimentalTelemetry.tracer === myTracer, 'Tracer should not override provided tracer')

        await checkTraces
      })
    })

    it('creates a span for generateText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const generateTextSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]

        assertObjectContains(generateTextSpan, {
          name: 'ai.generateText',
          resource: 'ai.generateText',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doGenerateSpan, {
          name: 'ai.generateText.doGenerate',
          resource: 'ai.generateText.doGenerate',
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
        maxTokens: 100,
        temperature: 0.5,
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for generateObject', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const generateObjectSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]

        assertObjectContains(generateObjectSpan, {
          name: 'ai.generateObject',
          resource: 'ai.generateObject',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doGenerateSpan, {
          name: 'ai.generateObject.doGenerate',
          resource: 'ai.generateObject.doGenerate',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' },
        },
        required: ['name', 'age', 'height'],
        additionalProperties: false,
      })

      const result = await ai.generateObject({
        model: openai('gpt-4o-mini'),
        schema,
        prompt: 'Invent a character for a video game',
      })

      assert.ok(result.object, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span for embed', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const embedSpan = traces[0][0]
        const doEmbedSpan = traces[0][1]

        assertObjectContains(embedSpan, {
          name: 'ai.embed',
          resource: 'ai.embed',
          meta: {
            'ai.request.model': 'text-embedding-ada-002',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doEmbedSpan, {
          name: 'ai.embed.doEmbed',
          resource: 'ai.embed.doEmbed',
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

    it('creates a span for embedMany', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const embedManySpan = traces[0][0]
        const doEmbedSpan = traces[0][1]

        assertObjectContains(embedManySpan, {
          name: 'ai.embedMany',
          resource: 'ai.embedMany',
          meta: {
            'ai.request.model': 'text-embedding-ada-002',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doEmbedSpan, {
          name: 'ai.embedMany.doEmbed',
          resource: 'ai.embedMany.doEmbed',
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

    it('creates a span for streamText', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const streamTextSpan = traces[0][0]
        const doStreamSpan = traces[0][1]

        assertObjectContains(streamTextSpan, {
          name: 'ai.streamText',
          resource: 'ai.streamText',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doStreamSpan, {
          name: 'ai.streamText.doStream',
          resource: 'ai.streamText.doStream',
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
        maxTokens: 100,
        temperature: 0.5,
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

        assertObjectContains(streamObjectSpan, {
          name: 'ai.streamObject',
          resource: 'ai.streamObject',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doStreamSpan, {
          name: 'ai.streamObject.doStream',
          resource: 'ai.streamObject.doStream',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' },
        },
        required: ['name', 'age', 'height'],
        additionalProperties: false,
      })

      const result = await ai.streamObject({
        model: openai('gpt-4o-mini'),
        schema,
        prompt: 'Invent a character for a video game',
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

        assertObjectContains(toolCallSpan, {
          name: 'ai.generateText',
          resource: 'ai.generateText',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doGenerateSpan, {
          name: 'ai.generateText.doGenerate',
          resource: 'ai.generateText.doGenerate',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assert.strictEqual(toolCallSpan2.name, 'ai.toolCall')
        assert.strictEqual(toolCallSpan2.resource, 'ai.toolCall')

        assertObjectContains(doGenerateSpan2, {
          name: 'ai.generateText.doGenerate',
          resource: 'ai.generateText.doGenerate',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })
      })

      let tools
      let maxStepsArg
      const toolSchema = ai.jsonSchema({
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The location to get the weather for' },
        },
        required: ['location'],
      })
      if (semifies(realVersion, '>=5.0.0')) {
        tools = {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: toolSchema,
            execute: async ({ location }) => ({
              location,
              temperature: 72,
            }),
          }),
        }

        maxStepsArg = { stopWhen: ai.stepCountIs(5) }
      } else {
        tools = [ai.tool({
          id: 'weather',
          description: 'Get the weather in a given location',
          parameters: toolSchema,
          execute: async ({ location }) => ({
            location,
            temperature: 72,
          }),
        })]

        maxStepsArg = { maxSteps: 5 }
      }

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        providerOptions: {
          openai: {
            store: false,
          },
        },
        ...maxStepsArg,
      })

      assert.ok(result.text, 'Expected result to be truthy')

      await checkTraces
    })

    it('creates a span that respects the functionId', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const generateTextSpan = traces[0][0]
        const doGenerateSpan = traces[0][1]

        assertObjectContains(generateTextSpan, {
          name: 'ai.generateText',
          resource: 'test',
          meta: {
            'ai.request.model': 'gpt-4o-mini',
            'ai.request.model_provider': 'openai',
          },
        })

        assertObjectContains(doGenerateSpan, {
          name: 'ai.generateText.doGenerate',
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
        maxTokens: 100,
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
