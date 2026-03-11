'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const promptChannel = channel('dd-trace:vercel-ai:aiguard:prompt')
const toolCallChannel = channel('dd-trace:vercel-ai:aiguard:tool-call')
const enabledConfig = {
  enabled: true,
  experimental: {
    aiguard: {
      enabled: true,
    },
  },
}

describe('VercelAIGuardPlugin', () => {
  let log
  let tracer
  let plugin
  let VercelAIPlugin
  let VercelAIGuardPlugin

  beforeEach(() => {
    log = {
      error: sinon.stub(),
    }
    VercelAIGuardPlugin = proxyquire('../src/aiguard', {
      '../../dd-trace/src/log': log,
    })
    VercelAIPlugin = proxyquire('../src/index', {
      './aiguard': VercelAIGuardPlugin,
    })
    tracer = {
      aiguard: {
        evaluate: sinon.stub().resolves(undefined),
      },
    }
    plugin = new VercelAIGuardPlugin(tracer, {})
  })

  afterEach(() => {
    plugin.configure(false)
    sinon.restore()
  })

  it('subscribes only when AI Guard is enabled', () => {
    assert.equal(VercelAIPlugin.plugins.aiguard, VercelAIGuardPlugin)
    assert.equal(promptChannel.hasSubscribers, false)
    assert.equal(toolCallChannel.hasSubscribers, false)

    plugin.configure(enabledConfig)

    assert.equal(promptChannel.hasSubscribers, true)
    assert.equal(toolCallChannel.hasSubscribers, true)

    plugin.configure({
      enabled: true,
      experimental: {
        aiguard: {
          enabled: false,
        },
      },
    })

    assert.equal(promptChannel.hasSubscribers, false)
    assert.equal(toolCallChannel.hasSubscribers, false)
  })

  it('converts prompts and sanitizes abort errors', async () => {
    tracer.aiguard.evaluate.rejects({
      name: 'AIGuardAbortError',
      reason: 'secret reason',
      tags: ['prompt-injection'],
    })
    plugin.configure(enabledConfig)

    const ctx = {
      fnName: 'generateText',
      params: {
        prompt: [{ role: 'user', content: 'hello' }],
      },
    }

    promptChannel.publish(ctx)

    assert.deepStrictEqual(ctx.baseMessages, [{ role: 'user', content: 'hello' }])
    await assert.rejects(
      () => ctx.blockPromise,
      error => error instanceof Error &&
        error.name === 'Error' &&
        error.message === 'Prompt blocked by AI Guard security policy' &&
        !('reason' in error) &&
        !('tags' in error)
    )
    sinon.assert.calledOnceWithExactly(
      tracer.aiguard.evaluate,
      [{ role: 'user', content: 'hello' }],
      { block: true }
    )
  })

  it('marks prompt normalization failures to skip later tool call evaluation', () => {
    plugin.configure(enabledConfig)

    const ctx = {
      fnName: 'generateText',
      params: {
        prompt: [{
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolName: 'lookupWeather',
            input: { city: 'Tokyo' },
          }],
        }],
      },
    }

    promptChannel.publish(ctx)

    assert.equal(ctx.skipToolCallEvaluation, true)
    assert.equal(ctx.baseMessages, undefined)
    assert.equal(ctx.blockPromise, undefined)
    sinon.assert.notCalled(tracer.aiguard.evaluate)
    sinon.assert.calledOnceWithExactly(
      log.error,
      '[AI Guard] Failed to convert prompt for %s: %s',
      'generateText',
      'Tool call ID must be a non-empty string'
    )
  })

  it('fails open on non-abort evaluation errors', async () => {
    plugin.configure(enabledConfig)

    const cases = [
      {
        title: 'prompt channel with synchronous throw',
        prepare () {
          tracer.aiguard.evaluate.callsFake(() => {
            throw new Error('sync down')
          })
        },
        ctx: {
          fnName: 'generateText',
          params: {
            prompt: [{ role: 'user', content: 'hello' }],
          },
        },
        publish () {
          promptChannel.publish(this.ctx)
        },
        expectedMessages: [{ role: 'user', content: 'hello' }],
        expectedLogMessage: 'sync down',
      },
      {
        title: 'tool-call channel with asynchronous rejection',
        prepare () {
          tracer.aiguard.evaluate.rejects(new Error('network down'))
        },
        ctx: {
          fnName: 'streamText',
          baseMessages: [{ role: 'user', content: 'hello' }],
          toolCall: {
            toolCallId: 'call-1',
            toolName: 'lookupWeather',
            input: { city: 'Tokyo' },
          },
        },
        publish () {
          toolCallChannel.publish(this.ctx)
        },
        expectedMessages: createToolCallMessages(),
        expectedLogMessage: 'network down',
      },
      {
        title: 'tool-call channel with synchronous throw',
        prepare () {
          tracer.aiguard.evaluate.callsFake(() => {
            throw new Error('sync down')
          })
        },
        ctx: {
          fnName: 'streamText',
          baseMessages: [{ role: 'user', content: 'hello' }],
          toolCall: {
            toolCallId: 'call-1',
            toolName: 'lookupWeather',
            input: { city: 'Tokyo' },
          },
        },
        publish () {
          toolCallChannel.publish(this.ctx)
        },
        expectedMessages: createToolCallMessages(),
        expectedLogMessage: 'sync down',
      },
    ]

    for (const testCase of cases) {
      tracer.aiguard.evaluate.resetBehavior()
      tracer.aiguard.evaluate.resetHistory()
      log.error.resetHistory()

      testCase.prepare()
      testCase.publish()

      assert.ok(testCase.ctx.blockPromise, testCase.title)
      await testCase.ctx.blockPromise

      sinon.assert.calledOnceWithExactly(
        tracer.aiguard.evaluate,
        testCase.expectedMessages,
        { block: true }
      )
      sinon.assert.calledOnceWithExactly(
        log.error,
        '[AI Guard] Evaluation failed: %s',
        testCase.expectedLogMessage
      )
    }
  })

  it('uses the AI Guard SDK exposed on the wrapped tracer proxy', async () => {
    const wrappedTracer = {
      _tracer: {},
      aiguard: {
        evaluate: sinon.stub().resolves(undefined),
      },
    }

    plugin = new VercelAIGuardPlugin(wrappedTracer, {})
    plugin.configure(enabledConfig)

    const ctx = {
      fnName: 'streamObject',
      params: {
        prompt: [{ role: 'user', content: 'hello' }],
      },
    }

    promptChannel.publish(ctx)

    assert.ok(ctx.blockPromise)
    await ctx.blockPromise

    sinon.assert.calledOnceWithExactly(
      wrappedTracer.aiguard.evaluate,
      [{ role: 'user', content: 'hello' }],
      { block: true }
    )
  })
})

function createToolCallMessages () {
  return [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        function: {
          name: 'lookupWeather',
          arguments: '{"city":"Tokyo"}',
        },
      }],
    },
  ]
}
