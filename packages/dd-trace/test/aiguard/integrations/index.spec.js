'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')

describe('AIGuard integration wiring', () => {
  const config = { experimental: { aiguard: { block: true } } }
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

    integrations.enable(aiguard, true)
    integrations.disable()

    sinon.assert.calledOnceWithExactly(anthropicIntegration.enable, aiguard, true)
    sinon.assert.calledOnceWithExactly(openaiIntegration.enable, aiguard, true)
    sinon.assert.calledOnceWithExactly(vercelAiIntegration.enable, aiguard, true)
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
