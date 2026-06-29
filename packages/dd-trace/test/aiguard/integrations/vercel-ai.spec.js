'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const vercelAiIntegration = require('../../../src/aiguard/integrations/vercel-ai')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const doGenerateBeforeChannel = channel('dd-trace:vercel-ai:doGenerate:before')
const doGenerateAfterChannel = channel('dd-trace:vercel-ai:doGenerate:after')
const doStreamAfterChannel = channel('dd-trace:vercel-ai:doStream:after')

describe('AIGuard Vercel AI integration', () => {
  const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]
  let evaluate
  let disable

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    disable = vercelAiIntegration.enable({ evaluate }, true)
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

  it('evaluates doGenerate input messages', async () => {
    const ctx = publish(doGenerateBeforeChannel, { prompt })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'ai',
    })
    assert.strictEqual(ctx.abortController.signal.aborted, false)
  })

  it('declines empty prompt payloads without pushing to pending', () => {
    const ctx = publish(doGenerateBeforeChannel, { prompt: [] })

    assert.strictEqual(ctx.pending.length, 0)
    sinon.assert.notCalled(evaluate)
  })

  it('evaluates doGenerate output messages', async () => {
    const content = [{ type: 'text', text: 'Hello!' }]
    const ctx = publish(doGenerateAfterChannel, { prompt, result: { content } })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello!' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'ai',
    })
  })

  it('evaluates accumulated doStream output chunks', async () => {
    const chunks = [
      { type: 'text-delta', textDelta: 'Hello' },
      { type: 'text-delta', textDelta: ' world' },
    ]
    const ctx = publish(doStreamAfterChannel, { prompt, chunks })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello world' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'ai',
    })
  })

  it('aborts with the original AIGuardAbortError', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.rejects(err)

    const ctx = publish(doGenerateBeforeChannel, { prompt })
    await Promise.all(ctx.pending)

    assert.strictEqual(ctx.abortController.signal.reason, err)
  })
})
