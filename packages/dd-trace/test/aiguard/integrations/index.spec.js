'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')

describe('AIGuard integration wiring', () => {
  const config = {
    aiguard: {
      DD_AI_GUARD_ANALYZE_STREAM_RESPONSES_ENABLED: true,
      DD_AI_GUARD_BLOCK: true,
    },
  }
  let AIGuard
  let evaluate
  let aiguard

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    AIGuard = sinon.stub().returns({ evaluate })

    aiguard = proxyquire('../../../src/aiguard/index', {
      '../log': { error: sinon.stub() },
      './sdk': AIGuard,
    })
  })

  afterEach(() => {
    aiguard.disable()
    sinon.restore()
  })

  function publishChatIntercept () {
    const ctx = { arguments: [{ messages: [{ role: 'user', content: 'Hello' }] }], stream: false }
    chatCompletionsInterceptChannel.publish(ctx)
    return { ctx, intercepted: typeof ctx.beforeResult === 'function' }
  }

  it('subscribes, unsubscribes, and resubscribes AI Guard integrations', async () => {
    aiguard.enable({}, config)

    const enabled = publishChatIntercept()
    assert.strictEqual(enabled.intercepted, true)
    await enabled.ctx.beforeResult()
    sinon.assert.calledOnce(evaluate)

    aiguard.disable()

    assert.strictEqual(publishChatIntercept().intercepted, false)

    aiguard.enable({}, config)

    const reenabled = publishChatIntercept()
    assert.strictEqual(reenabled.intercepted, true)
    await reenabled.ctx.beforeResult()
    sinon.assert.calledTwice(AIGuard)
    sinon.assert.calledTwice(evaluate)
  })

  for (const disabled of [
    [],
    ['anthropic'],
    ['openai'],
    ['ai'],
    ['anthropic', 'openai'],
    ['anthropic', 'openai', 'ai'],
    ['openai', 'openai', 'unknown'],
    ['unknown', 'OpenAI'],
  ]) {
    it(`only subscribes enabled integrations with disabled list ${JSON.stringify(disabled)}`, async () => {
      aiguard.enable({}, {
        aiguard: { ...config.aiguard, DD_AIGUARD_DISABLED_INTEGRATIONS: disabled },
      })

      const cases = [
        ['anthropic', 'dd-trace:anthropic:messages:intercept', { messages: [{ role: 'user', content: 'Hello' }] }],
        ['openai', 'dd-trace:openai:chat.completions:intercept', { messages: [{ role: 'user', content: 'Hello' }] }],
        ['openai', 'dd-trace:openai:responses:intercept', { input: 'Hello' }],
        ['ai', 'dd-trace:vercel-ai:model:intercept', {
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        }],
      ]

      let evaluations = 0
      for (const [name, channelName, options] of cases) {
        const interceptChannel = channel(channelName)
        const ctx = { arguments: [options], method: 'doGenerate' }
        interceptChannel.publish(ctx)
        if (disabled.includes(name)) {
          assert.strictEqual(interceptChannel.hasSubscribers, false)
          assert.strictEqual(ctx.beforeResult, undefined)
          assert.strictEqual(ctx.onResult, undefined)
        } else {
          assert.strictEqual(typeof ctx.onResult, 'function')
          await ctx.beforeResult()
          evaluations++
          assert.strictEqual(evaluate.lastCall.args[1].integration, name)
        }
      }
      sinon.assert.callCount(evaluate, evaluations)
      assert.strictEqual(channel('dd-trace:anthropic:messages:prepare').hasSubscribers, !disabled.includes('anthropic'))

      aiguard.disable()
      for (const [, channelName] of cases) {
        assert.strictEqual(channel(channelName).hasSubscribers, false)
      }
      assert.strictEqual(channel('dd-trace:anthropic:messages:prepare').hasSubscribers, false)
    })
  }

  it('applies a new disabled list after disabling and re-enabling AI Guard', async () => {
    aiguard.enable({}, {
      aiguard: { ...config.aiguard, DD_AIGUARD_DISABLED_INTEGRATIONS: ['openai'] },
    })
    assert.strictEqual(publishChatIntercept().intercepted, false)

    aiguard.disable()
    aiguard.enable({}, config)
    await publishChatIntercept().ctx.beforeResult()
    sinon.assert.calledOnce(evaluate)

    aiguard.disable()
    aiguard.enable({}, {
      aiguard: { ...config.aiguard, DD_AIGUARD_DISABLED_INTEGRATIONS: ['openai'] },
    })
    assert.strictEqual(publishChatIntercept().intercepted, false)
    sinon.assert.calledOnce(evaluate)
  })

  it('enables and disables providers through the integrations index', () => {
    const anthropicIntegration = {
      enable: sinon.stub(),
      disable: sinon.stub(),
    }
    const openaiIntegration = {
      enable: sinon.stub(),
      disable: sinon.stub(),
    }
    const vercelAiIntegration = {
      enable: sinon.stub(),
      disable: sinon.stub(),
    }
    const integrations = proxyquire('../../../src/aiguard/integrations', {
      './anthropic': anthropicIntegration,
      './openai': openaiIntegration,
      './vercel-ai': vercelAiIntegration,
    })
    const aiguard = { evaluate }

    integrations.enable(aiguard, true, true)
    integrations.disable()

    sinon.assert.calledOnceWithExactly(anthropicIntegration.enable, aiguard, true, true)
    sinon.assert.calledOnceWithExactly(openaiIntegration.enable, aiguard, true, true)
    sinon.assert.calledOnceWithExactly(vercelAiIntegration.enable, aiguard, true, true)
    sinon.assert.calledOnce(anthropicIntegration.disable)
    sinon.assert.calledOnce(openaiIntegration.disable)
    sinon.assert.calledOnce(vercelAiIntegration.disable)
    sinon.assert.callOrder(
      anthropicIntegration.enable,
      openaiIntegration.enable,
      vercelAiIntegration.enable,
      vercelAiIntegration.disable,
      openaiIntegration.disable,
      anthropicIntegration.disable,
    )
  })
})
