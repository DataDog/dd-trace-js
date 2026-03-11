'use strict'

const assert = require('node:assert/strict')
const { ReadableStream, TransformStream } = require('node:stream/web')

const { after, afterEach, describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const promptChannel = channel('dd-trace:vercel-ai:aiguard:prompt')
const toolCallChannel = channel('dd-trace:vercel-ai:aiguard:tool-call')
const originalReadableStream = globalThis.ReadableStream
const originalTransformStream = globalThis.TransformStream

if (globalThis.ReadableStream == null) {
  globalThis.ReadableStream = ReadableStream
}

if (globalThis.TransformStream == null) {
  globalThis.TransformStream = TransformStream
}

describe('ai AI Guard instrumentation', () => {
  let subscriptions = []

  after(() => {
    globalThis.ReadableStream = originalReadableStream
    globalThis.TransformStream = originalTransformStream
  })

  afterEach(() => {
    for (const { diagnosticChannel, handler } of subscriptions) {
      diagnosticChannel.unsubscribe(handler)
    }

    subscriptions = []
    delete globalThis.AI_SDK_DEFAULT_PROVIDER
    sinon.restore()
  })

  it('does not eagerly resolve string models without AI Guard subscribers', async () => {
    const provider = {
      languageModel: sinon.stub().throws(new Error('should not resolve')),
    }

    globalThis.AI_SDK_DEFAULT_PROVIDER = provider

    const generateText = sinon.stub().resolves('ok')
    const ai = createPatchedAiExports({ generateText })

    const options = { model: 'gateway:model', prompt: [] }
    const result = await ai.generateText(options)

    assert.equal(result, 'ok')
    sinon.assert.calledOnce(generateText)
    sinon.assert.notCalled(provider.languageModel)
    assert.equal(generateText.firstCall.args[0].model, 'gateway:model')
  })

  it('does not direct-wrap tool exports', () => {
    const tool = sinon.stub().returns('wrapped-tool')
    const ai = createPatchedAiExports({ tool })
    const toolArgs = {
      description: 'Do something dangerous',
      id: 'dangerousOp',
    }

    assert.strictEqual(ai.tool, tool)
    assert.equal(ai.tool(toolArgs), 'wrapped-tool')
    sinon.assert.calledOnceWithExactly(tool, toolArgs)
  })

  it('blocks prompt evaluation even when telemetry is disabled', async () => {
    const model = createModel({
      doGenerate: sinon.stub().resolves({ content: [] }),
    })
    const ai = createPatchedAiExports()

    subscribe(subscriptions, promptChannel, ctx => {
      ctx.blockPromise = Promise.reject(new Error('Prompt blocked by AI Guard security policy'))
    })

    await assert.rejects(
      () => ai.generateText({
        model,
        prompt: [{ role: 'user', content: 'blocked' }],
        experimental_telemetry: { isEnabled: false },
      }),
      isPromptBlockedError
    )

    sinon.assert.notCalled(model.doGenerate)
  })

  it('blocks prompt evaluation for non-step object APIs', async () => {
    const ai = createPatchedAiExports()
    const cases = [
      {
        title: 'generateObject',
        model: createModel({
          doGenerate: sinon.stub().resolves({ content: [] }),
        }),
        invoke (model) {
          return ai.generateObject({
            model,
            prompt: [{ role: 'user', content: 'blocked object generation' }],
          })
        },
        verifyNotCalled (model) {
          sinon.assert.notCalled(model.doGenerate)
        },
      },
      {
        title: 'streamObject',
        model: createModel({
          doStream: sinon.stub().resolves({ stream: createStream([]) }),
        }),
        invoke (model) {
          return ai.streamObject({
            model,
            prompt: [{ role: 'user', content: 'blocked object stream' }],
          })
        },
        verifyNotCalled (model) {
          sinon.assert.notCalled(model.doStream)
        },
      },
    ]

    subscribe(subscriptions, promptChannel, ctx => {
      ctx.blockPromise = Promise.reject(new Error('Prompt blocked by AI Guard security policy'))
    })

    for (const testCase of cases) {
      await assert.rejects(() => testCase.invoke(testCase.model), isPromptBlockedError, testCase.title)
      testCase.verifyNotCalled(testCase.model)
    }
  })

  it('does not double wrap same-fnName compatibility proxies from prepareStep', async () => {
    const model = createModel({
      doGenerate: sinon.stub().resolves({ content: [] }),
    })
    const ai = createPatchedAiExports({
      async generateText (options) {
        const prepareStepResult = await options.prepareStep({
          model: createTransparentProxy(options.model),
        })

        return prepareStepResult.model.doGenerate(buildParams(options))
      },
    })

    let promptCount = 0
    subscribe(subscriptions, promptChannel, ctx => {
      promptCount++
      ctx.baseMessages = []
    })

    await ai.generateText({
      model,
      prompt: [{ role: 'user', content: 'hello' }],
      prepareStep ({ model }) {
        return { model }
      },
    })

    assert.equal(promptCount, 1)
    sinon.assert.calledOnce(model.doGenerate)
  })

  it('normalizes wrapped models returned from another fnName', async () => {
    const model = createModel({
      doGenerate: sinon.stub().resolves({ content: [] }),
      doStream: sinon.stub().resolves({ stream: createStream([]) }),
    })
    let priorWrappedModel
    const fnNames = []
    const ai = createPatchedAiExports({
      async generateText (options) {
        const prepareStepResult = await options.prepareStep({
          model: createTransparentProxy(options.model),
        })

        priorWrappedModel = prepareStepResult.model
        return priorWrappedModel.doGenerate(buildParams(options))
      },
      async streamText (options) {
        const prepareStepResult = await options.prepareStep({
          model: createTransparentProxy(options.model),
        })

        return prepareStepResult.model.doStream(buildParams(options))
      },
    })

    subscribe(subscriptions, promptChannel, ctx => {
      fnNames.push(ctx.fnName)
      ctx.baseMessages = []
    })

    await ai.generateText({
      model,
      prompt: [{ role: 'user', content: 'step 1' }],
      prepareStep ({ model }) {
        return { model }
      },
    })

    await ai.streamText({
      model,
      prompt: [{ role: 'user', content: 'step 2' }],
      prepareStep () {
        return { model: priorWrappedModel }
      },
    })

    assert.deepStrictEqual(fnNames, ['generateText', 'streamText'])
    sinon.assert.calledOnce(model.doGenerate)
    sinon.assert.calledOnce(model.doStream)
  })

  it('resolves string models with the correct provider precedence', async () => {
    subscribe(subscriptions, promptChannel, ctx => {
      ctx.baseMessages = []
    })

    const cases = [
      {
        title: 'default provider wins',
        modelId: 'openai:gpt-4o',
        build () {
          const defaultModel = createModel({
            doGenerate: sinon.stub().resolves({ content: [] }),
          })
          const gatewayModel = createModel({
            doGenerate: sinon.stub().resolves({ content: [] }),
          })
          const defaultProvider = {
            languageModel: sinon.stub().returns(defaultModel),
          }
          const gateway = {
            languageModel: sinon.stub().returns(gatewayModel),
          }

          globalThis.AI_SDK_DEFAULT_PROVIDER = defaultProvider

          return {
            defaultModel,
            defaultProvider,
            gateway,
            gatewayModel,
          }
        },
        verify (fixtures) {
          sinon.assert.calledOnceWithExactly(fixtures.defaultProvider.languageModel, 'openai:gpt-4o')
          sinon.assert.notCalled(fixtures.gateway.languageModel)
          sinon.assert.calledOnce(fixtures.defaultModel.doGenerate)
          sinon.assert.notCalled(fixtures.gatewayModel.doGenerate)
        },
      },
      {
        title: 'gateway fallback is used when the default provider is unavailable',
        modelId: 'gateway:gpt-4o-mini',
        build () {
          delete globalThis.AI_SDK_DEFAULT_PROVIDER

          const gatewayModel = createModel({
            doGenerate: sinon.stub().resolves({ content: [] }),
          })
          const gateway = {
            languageModel: sinon.stub().returns(gatewayModel),
          }

          return {
            gateway,
            gatewayModel,
          }
        },
        verify (fixtures) {
          sinon.assert.calledOnceWithExactly(fixtures.gateway.languageModel, 'gateway:gpt-4o-mini')
          sinon.assert.calledOnce(fixtures.gatewayModel.doGenerate)
        },
      },
    ]

    for (const testCase of cases) {
      const fixtures = testCase.build()
      const ai = createPatchedAiExports({ gateway: fixtures.gateway })

      await ai.generateText({
        model: testCase.modelId,
        prompt: [{ role: 'user', content: 'hello' }],
      })

      testCase.verify(fixtures)
    }
  })

  it('rewraps string models returned from prepareStep hooks', async () => {
    subscribe(subscriptions, promptChannel, ctx => {
      ctx.baseMessages = []
    })

    const cases = [
      { title: 'prepareStep', optionName: 'prepareStep' },
      { title: 'experimental_prepareStep', optionName: 'experimental_prepareStep' },
    ]

    for (const testCase of cases) {
      const initialModel = createModel({
        doGenerate: sinon.stub().resolves({ content: [] }),
      })
      const steppedModel = createModel({
        doGenerate: sinon.stub().resolves({ content: [] }),
      })
      const gateway = {
        languageModel: sinon.stub().returns(steppedModel),
      }
      const ai = createPatchedAiExports({ gateway })

      await ai.generateText({
        model: initialModel,
        prompt: [{ role: 'user', content: 'hello' }],
        [testCase.optionName] () {
          return { model: 'gateway:step-model' }
        },
      })

      sinon.assert.calledOnceWithExactly(gateway.languageModel, 'gateway:step-model')
      sinon.assert.notCalled(initialModel.doGenerate)
      sinon.assert.calledOnce(steppedModel.doGenerate)
    }
  })

  it('evaluates tool calls only for user-defined tool contexts', async () => {
    subscribe(subscriptions, promptChannel, ctx => {
      ctx.baseMessages = []
    })

    const cases = [
      {
        title: 'top-level tools',
        model: createModel({
          doGenerate: sinon.stub().resolves({
            toolCalls: [
              {
                toolCallId: 'call-1',
                toolName: 'firstTool',
                input: { value: 1 },
              },
              {
                toolCallId: 'call-2',
                toolName: 'secondTool',
                input: { value: 2 },
              },
            ],
          }),
        }),
        invoke (ai, model) {
          return ai.generateText({
            model,
            prompt: [{ role: 'user', content: 'call tools' }],
            tools: [{ name: 'firstTool' }, { name: 'secondTool' }],
          })
        },
        expectedToolCalls: ['firstTool', 'secondTool'],
      },
      {
        title: 'nested mode.tools',
        model: createModel({
          doGenerate: sinon.stub().resolves({
            toolCalls: [{
              toolCallId: 'call-1',
              toolName: 'firstTool',
              input: { value: 1 },
            }],
          }),
        }),
        invoke (ai, model) {
          return ai.generateText({
            model,
            mode: {
              tools: [{ name: 'firstTool' }],
            },
            prompt: [{ role: 'user', content: 'call tools' }],
          })
        },
        expectedToolCalls: ['firstTool'],
      },
      {
        title: 'structured output path without user-defined tools',
        model: createModel({
          doGenerate: sinon.stub().resolves({
            content: [{
              type: 'tool-call',
              toolCallId: 'json-shape',
              toolName: 'structured',
              input: { ignored: true },
            }],
          }),
        }),
        invoke (ai, model) {
          return ai.generateObject({
            model,
            prompt: [{ role: 'user', content: 'structured output' }],
          })
        },
        expectedToolCalls: [],
      },
    ]
    const seenToolCalls = []

    subscribe(subscriptions, toolCallChannel, ctx => {
      seenToolCalls.push(ctx.toolCall.toolName)
    })

    for (const testCase of cases) {
      seenToolCalls.length = 0

      const ai = createPatchedAiExports()
      await testCase.invoke(ai, testCase.model)

      assert.deepStrictEqual(seenToolCalls, testCase.expectedToolCalls, testCase.title)
    }
  })

  it('skips tool call evaluation when prompt normalization already failed open', async () => {
    const model = createModel({
      doGenerate: sinon.stub().resolves({
        toolCalls: [{
          toolCallId: 'call-1',
          toolName: 'dangerousTool',
          input: { query: 'drop table' },
        }],
      }),
    })
    const ai = createPatchedAiExports()
    let toolCallCount = 0

    subscribe(subscriptions, promptChannel, ctx => {
      ctx.skipToolCallEvaluation = true
    })
    subscribe(subscriptions, toolCallChannel, () => {
      toolCallCount++
    })

    await ai.generateText({
      model,
      prompt: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'dangerousTool' }],
    })

    assert.equal(toolCallCount, 0)
    sinon.assert.calledOnce(model.doGenerate)
  })

  it('terminates streams with a sanitized error chunk when a tool call is blocked', async () => {
    const model = createModel({
      doStream: sinon.stub().resolves({
        stream: createStream([
          { type: 'text-delta', delta: 'A' },
          {
            type: 'tool-call',
            toolCallId: 'blocked-call',
            toolName: 'dangerousTool',
            input: { query: 'drop table' },
          },
          { type: 'finish', finishReason: 'stop' },
        ]),
      }),
    })
    const ai = createPatchedAiExports()

    subscribe(subscriptions, promptChannel, ctx => {
      ctx.baseMessages = [{ role: 'user', content: 'hello' }]
    })
    subscribe(subscriptions, toolCallChannel, ctx => {
      ctx.blockPromise = Promise.reject(new Error('Tool call blocked by AI Guard security policy'))
    })

    const result = await ai.streamText({
      model,
      mode: {
        tools: [{ name: 'dangerousTool' }],
      },
      prompt: [{ role: 'user', content: 'hello' }],
    })
    const chunks = await readAllChunks(result.stream)

    assert.deepStrictEqual(chunks.map(chunk => chunk.type), ['text-delta', 'error'])
    assert.equal(chunks[1].error.name, 'Error')
    assert.equal(chunks[1].error.message, 'Tool call blocked by AI Guard security policy')
  })

  it('passes partial tool-call stream chunks through and only evaluates completed tool calls', async () => {
    const model = createModel({
      doStream: sinon.stub().resolves({
        stream: createStream([
          { type: 'tool-call-streaming-start', toolCallId: 'call-1', toolName: 'dangerousTool' },
          { type: 'tool-call-delta', toolCallId: 'call-1', delta: '{"query":"' },
          { type: 'tool-input-start', toolCallId: 'call-1' },
          { type: 'tool-input-delta', toolCallId: 'call-1', delta: 'drop table"}' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'dangerousTool',
            input: { query: 'drop table' },
          },
          { type: 'finish', finishReason: 'tool-calls' },
        ]),
      }),
    })
    const ai = createPatchedAiExports()
    const seenToolCalls = []

    subscribe(subscriptions, promptChannel, ctx => {
      ctx.baseMessages = [{ role: 'user', content: 'hello' }]
    })
    subscribe(subscriptions, toolCallChannel, ctx => {
      seenToolCalls.push(ctx.toolCall.toolName)
      ctx.blockPromise = Promise.reject(new Error('Tool call blocked by AI Guard security policy'))
    })

    const result = await ai.streamText({
      model,
      prompt: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'dangerousTool' }],
    })
    const chunks = await readAllChunks(result.stream)

    assert.deepStrictEqual(seenToolCalls, ['dangerousTool'])
    assert.deepStrictEqual(chunks.map(chunk => chunk.type), [
      'tool-call-streaming-start',
      'tool-call-delta',
      'tool-input-start',
      'tool-input-delta',
      'error',
    ])
    assert.equal(chunks[4].error.name, 'Error')
    assert.equal(chunks[4].error.message, 'Tool call blocked by AI Guard security policy')
  })

  it('strips custom fields from plain errors before exposing them', async () => {
    const model = createModel({
      doGenerate: sinon.stub().resolves({ content: [] }),
    })
    const ai = createPatchedAiExports()

    subscribe(subscriptions, promptChannel, ctx => {
      const error = new Error('blocked')
      error.code = 'LEAK'
      error.cause = new Error('boom')
      ctx.blockPromise = Promise.reject(error)
    })

    await assert.rejects(
      () => ai.generateText({
        model,
        prompt: [{ role: 'user', content: 'blocked' }],
      }),
      error => error instanceof Error &&
        error.name === 'Error' &&
        error.message === 'blocked' &&
        !('code' in error) &&
        !('cause' in error)
    )
  })
})

/**
 * @param {Array<{ diagnosticChannel: object, handler: Function }>} subscriptions
 * @param {object} diagnosticChannel
 * @param {(ctx: object) => void} handler
 * @returns {void}
 */
function subscribe (subscriptions, diagnosticChannel, handler) {
  diagnosticChannel.subscribe(handler)
  subscriptions.push({ diagnosticChannel, handler })
}

/**
 * @param {Error} error
 * @returns {boolean}
 */
function isPromptBlockedError (error) {
  return error instanceof Error &&
    error.name === 'Error' &&
    error.message === 'Prompt blocked by AI Guard security policy'
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function createPatchedAiExports (overrides = {}) {
  const hooks = []

  proxyquire.noPreserveCache()('../src/ai', {
    './helpers/instrument': {
      addHook (options, hook) {
        hooks.push({ options, hook })
      },
      getHooks () {
        return []
      },
    },
  })

  const aiExports = {
    embed: sinon.stub().resolves(undefined),
    embedMany: sinon.stub().resolves(undefined),
    gateway: undefined,
    async generateObject (options) {
      return options.model.doGenerate(buildParams(options))
    },
    async generateText (options) {
      const prepareStep = options.prepareStep ?? options.experimental_prepareStep
      let model = options.model

      if (typeof prepareStep === 'function') {
        const result = await prepareStep({ model })
        if (result?.model) {
          model = result.model
        }
      }

      return model.doGenerate(buildParams(options))
    },
    async streamObject (options) {
      return options.model.doStream(buildParams(options))
    },
    async streamText (options) {
      const prepareStep = options.prepareStep ?? options.experimental_prepareStep
      let model = options.model

      if (typeof prepareStep === 'function') {
        const result = await prepareStep({ model })
        if (result?.model) {
          model = result.model
        }
      }

      return model.doStream(buildParams(options))
    },
    tool: sinon.stub(),
    ...overrides,
  }

  const cjsHook = hooks.find(entry => !entry.options.file)
  return cjsHook.hook(aiExports)
}

/**
 * @param {object} options
 * @returns {{ prompt: Array<object>, tools: unknown, mode: unknown }}
 */
function buildParams (options) {
  return {
    mode: options.mode,
    prompt: options.prompt ?? [],
    tools: options.tools,
  }
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function createModel (overrides = {}) {
  return {
    specificationVersion: overrides.specificationVersion ?? 'v3',
    provider: overrides.provider ?? 'mock-provider',
    modelId: overrides.modelId ?? 'mock-model',
    doGenerate: overrides.doGenerate ?? sinon.stub().resolves({ content: [] }),
    doStream: overrides.doStream ?? sinon.stub().resolves({ stream: createStream([]) }),
    get providerLabel () {
      return `${this.provider}:${this.modelId}`
    },
  }
}

/**
 * @param {Array<object>} chunks
 * @returns {ReadableStream}
 */
function createStream (chunks) {
  return new ReadableStream({
    start (controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }

      controller.close()
    },
  })
}

/**
 * @param {ReadableStream} stream
 * @returns {Promise<Array<object>>}
 */
function readAllChunks (stream) {
  const reader = stream.getReader()
  const chunks = []

  return reader.read().then(function handleResult ({ done, value }) {
    if (done) {
      return chunks
    }

    chunks.push(value)
    return reader.read().then(handleResult)
  })
}

/**
 * @param {object} target
 * @returns {object}
 */
function createTransparentProxy (target) {
  return new Proxy(target, {
    get (currentTarget, property, receiver) {
      return Reflect.get(currentTarget, property, receiver)
    },
  })
}
