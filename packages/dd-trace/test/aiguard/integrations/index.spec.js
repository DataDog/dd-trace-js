'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const chatCompletionsBeforeChannel = channel('dd-trace:openai:chat.completions:before')

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

  function publishChatBefore () {
    const abortController = new AbortController()
    const ctx = {
      args: [{ messages: [{ role: 'user', content: 'Hello' }] }],
      abortController,
      pending: [],
    }
    chatCompletionsBeforeChannel.publish(ctx)
    return ctx
  }

  it('subscribes, unsubscribes, and resubscribes AI Guard integrations', async () => {
    aiguard.enable({}, config)

    const enabledCtx = publishChatBefore()
    assert.strictEqual(enabledCtx.pending.length, 1)
    await Promise.all(enabledCtx.pending)
    sinon.assert.calledOnce(evaluate)

    aiguard.disable()

    const disabledCtx = publishChatBefore()
    assert.strictEqual(disabledCtx.pending.length, 0)

    aiguard.enable({}, config)

    const reenabledCtx = publishChatBefore()
    assert.strictEqual(reenabledCtx.pending.length, 1)
    await Promise.all(reenabledCtx.pending)
    sinon.assert.calledTwice(AIGuard)
    sinon.assert.calledTwice(evaluate)
  })

  it('enables and disables providers through the integrations index', () => {
    const openaiIntegration = {
      enable: sinon.stub(),
      disable: sinon.stub(),
    }
    const vercelAiIntegration = {
      enable: sinon.stub(),
      disable: sinon.stub(),
    }
    const integrations = proxyquire('../../../src/aiguard/integrations', {
      './openai': openaiIntegration,
      './vercel-ai': vercelAiIntegration,
    })
    const aiguard = { evaluate }

    integrations.enable(aiguard, true)
    integrations.disable()

    sinon.assert.calledOnceWithExactly(openaiIntegration.enable, aiguard, true)
    sinon.assert.calledOnceWithExactly(vercelAiIntegration.enable, aiguard, true)
    sinon.assert.calledOnce(openaiIntegration.disable)
    sinon.assert.calledOnce(vercelAiIntegration.disable)
    sinon.assert.callOrder(
      openaiIntegration.enable,
      vercelAiIntegration.enable,
      vercelAiIntegration.disable,
      openaiIntegration.disable,
    )
  })
})
