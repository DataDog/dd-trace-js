'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const chatCompletionsBeforeChannel = channel('dd-trace:openai:chat.completions:before')

describe('AIGuard integration wiring', () => {
  const config = { experimental: { aiguard: { block: true } } }
  let evaluate
  let aiguard

  beforeEach(() => {
    evaluate = sinon.stub().resolves()

    function MockAIGuard () {
      return { evaluate }
    }

    aiguard = proxyquire('../../../src/aiguard/index', {
      '../log': { error: sinon.stub() },
      './sdk': MockAIGuard,
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

  it('subscribes and unsubscribes AI Guard integrations from enable and disable', async () => {
    aiguard.enable({}, config)

    const enabledCtx = publishChatBefore()
    assert.strictEqual(enabledCtx.pending.length, 1)
    await Promise.all(enabledCtx.pending)
    sinon.assert.calledOnce(evaluate)

    aiguard.disable()

    const disabledCtx = publishChatBefore()
    assert.strictEqual(disabledCtx.pending.length, 0)
  })
})
