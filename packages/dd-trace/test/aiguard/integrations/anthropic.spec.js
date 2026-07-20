'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { anthropic: anthropicIntegration } = require('../../../src/aiguard/integrations')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const messagesBeforeChannel = channel('dd-trace:anthropic:messages:before')
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

describe('AIGuard Anthropic integration', () => {
  let evaluate

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    anthropicIntegration.enable({ evaluate }, true)
  })

  afterEach(() => {
    anthropicIntegration.disable()
    sinon.restore()
  })

  function publish (lifecycleChannel, payload) {
    const abortController = new AbortController()
    const ctx = { ...payload, abortController, pending: [] }
    lifecycleChannel.publish(ctx)
    return ctx
  }

  it('evaluates messages.create input messages', async () => {
    const args = [{
      system: 'Be concise',
      messages: [{ role: 'user', content: 'Hello' }],
    }]
    const ctx = publish(messagesBeforeChannel, { args })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'anthropic',
    })
  })

  it('forwards parentSpan to the SDK as childOf', async () => {
    const parentSpan = { fake: 'anthropic.request span' }
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const ctx = publish(messagesBeforeChannel, { args, parentSpan })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'anthropic',
      childOf: parentSpan,
    })
  })

  it('evaluates the input+output conversation once after the call', async () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const body = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
    }
    const ctx = publish(messagesAfterChannel, { args, body })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'anthropic',
    })
  })

  it('evaluates tool results before the next model call', async () => {
    const args = [{
      messages: [
        { role: 'user', content: 'find x' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'x=42' }],
        },
      ],
    }]
    const ctx = publish(messagesBeforeChannel, { args })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'find x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'x=42' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'anthropic',
    })
  })

  it('evaluates model tool calls after the response', async () => {
    const args = [{ messages: [{ role: 'user', content: 'find x' }] }]
    const body = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
    }
    const ctx = publish(messagesAfterChannel, { args, body })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'find x' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'anthropic',
    })
  })

  it('declines payloads without input messages', () => {
    const ctx = publish(messagesBeforeChannel, { args: [{}] })

    assert.strictEqual(ctx.pending.length, 0)
    sinon.assert.notCalled(evaluate)
  })

  it('declines after-payloads without output content', () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const ctx = publish(messagesAfterChannel, { args, body: { role: 'assistant', content: [] } })

    assert.strictEqual(ctx.pending.length, 0)
    sinon.assert.notCalled(evaluate)
  })

  it('evaluates after-payloads where body is a JSON string (from response.text())', async () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const ctx = publish(messagesAfterChannel, { args, body: JSON.stringify(body) })

    assert.strictEqual(ctx.pending.length, 1)
    await Promise.all(ctx.pending)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ], {
      block: true,
      source: SOURCE_AUTO,
      integration: 'anthropic',
    })
  })

  it('declines after-payloads where body is an invalid JSON string', () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]
    const ctx = publish(messagesAfterChannel, { args, body: 'not-json' })

    assert.strictEqual(ctx.pending.length, 0)
    sinon.assert.notCalled(evaluate)
  })

  it('aborts with the original AIGuardAbortError', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.rejects(err)

    const ctx = publish(messagesBeforeChannel, { args: [{ messages: [{ role: 'user', content: 'Hello' }] }] })
    await Promise.all(ctx.pending)

    assert.strictEqual(ctx.abortController.signal.reason, err)
  })

  it('aborts immediately when evaluation throws an AIGuardAbortError synchronously', () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.throws(err)

    const ctx = publish(messagesBeforeChannel, { args: [{ messages: [{ role: 'user', content: 'Hello' }] }] })

    assert.strictEqual(ctx.pending.length, 0)
    assert.strictEqual(ctx.abortController.signal.reason, err)
  })
})
