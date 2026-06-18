'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const openaiIntegration = require('../../../src/aiguard/integrations/openai')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const chatCompletionsBeforeChannel = channel('dd-trace:openai:chat.completions:before')
const chatCompletionsAfterChannel = channel('dd-trace:openai:chat.completions:after')
const responsesBeforeChannel = channel('dd-trace:openai:responses:before')
const responsesAfterChannel = channel('dd-trace:openai:responses:after')

describe('AIGuard OpenAI integration', () => {
  let evaluate
  let disable

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    disable = openaiIntegration.enable({ evaluate }, true)
  })

  afterEach(() => {
    disable()
    sinon.restore()
  })

  function publish (lifecycleChannel, payload) {
    const abortController = new AbortController()
    const ctx = { ...payload, abortController, pending: [] }
    lifecycleChannel.publish(ctx)
    return ctx
  }

  it('evaluates chat.completions input messages', async () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const ctx = publish(chatCompletionsBeforeChannel, { args })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'openai',
    })
  })

  it('forwards parentSpan to the SDK as childOf', async () => {
    const parentSpan = { fake: 'openai.request span' }
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const ctx = publish(chatCompletionsBeforeChannel, { args, parentSpan })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'openai',
      childOf: parentSpan,
    })
  })

  it('evaluates every chat.completions output choice independently', async () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const body = {
      choices: [
        { message: { role: 'assistant', content: 'one' } },
        { message: { role: 'assistant', content: 'two' } },
      ],
    }
    const ctx = publish(chatCompletionsAfterChannel, { args, body })

    assert.strictEqual(ctx.pending.length, 2)
    await Promise.all(ctx.pending)

    assert.deepStrictEqual(evaluate.firstCall.args, [[
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'one' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'openai',
    }])
    assert.deepStrictEqual(evaluate.secondCall.args, [[
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'two' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'openai',
    }])
  })

  it('evaluates responses input messages', async () => {
    const args = [{ instructions: 'Be concise', input: 'Hello' }]
    const ctx = publish(responsesBeforeChannel, { args })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'developer', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'openai',
    })
  })

  it('evaluates responses output messages as one conversation', async () => {
    const args = [{ input: 'Hello' }]
    const body = { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] }
    const ctx = publish(responsesAfterChannel, { args, body })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'openai',
    })
  })

  it('declines payloads without input messages', () => {
    const ctx = publish(chatCompletionsBeforeChannel, { args: [{}] })

    assert.strictEqual(ctx.pending.length, 0)
    sinon.assert.notCalled(evaluate)
  })

  it('aborts with the original AIGuardAbortError', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.rejects(err)

    const ctx = publish(responsesBeforeChannel, { args: [{ input: 'Hello' }] })
    await Promise.all(ctx.pending)

    assert.strictEqual(ctx.abortController.signal.reason, err)
  })

  it('aborts immediately when evaluation throws an AIGuardAbortError synchronously', () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.throws(err)

    const ctx = publish(responsesBeforeChannel, { args: [{ input: 'Hello' }] })

    assert.strictEqual(ctx.pending.length, 0)
    assert.strictEqual(ctx.abortController.signal.reason, err)
  })
})
