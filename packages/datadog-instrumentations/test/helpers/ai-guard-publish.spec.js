'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')

const { publishToAIGuard, aiguardChannel } = require('../../src/helpers/ai-guard-publish')

describe('ai-guard-publish', () => {
  let currentHandler

  afterEach(() => {
    if (currentHandler) {
      aiguardChannel.unsubscribe(currentHandler)
      currentHandler = undefined
    }
  })

  function subscribe (handler) {
    currentHandler = handler
    aiguardChannel.subscribe(handler)
  }

  it('publishes messages and resolves when a subscriber resolves', async () => {
    let received
    subscribe(ctx => {
      received = ctx.messages
      ctx.resolve()
    })
    const messages = [{ role: 'user', content: 'hi' }]
    await publishToAIGuard(messages)
    assert.deepStrictEqual(received, messages)
  })

  it('rejects with the subscriber-provided error', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    subscribe(ctx => ctx.reject(err))
    await assert.rejects(() => publishToAIGuard([{ role: 'user', content: 'hi' }]), e => e === err)
  })

  it('exposes the same aiguard channel used by subscribers', () => {
    assert.strictEqual(aiguardChannel.name, 'dd-trace:ai:aiguard')
  })
})
