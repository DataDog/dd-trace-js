'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { anthropic: anthropicIntegration } = require('../../../src/aiguard/integrations')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const messagesPrepareChannel = channel('dd-trace:anthropic:messages:prepare')
const messagesInterceptChannel = channel('dd-trace:anthropic:messages:intercept')

const EVAL_OPTS = { block: true, source: SOURCE_AUTO, integration: 'anthropic' }

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

  function prepare (args) {
    const ctx = { arguments: args }
    messagesPrepareChannel.publish(ctx)
    return ctx
  }

  /**
   * Publishes what the instrumentation publishes, and returns the callbacks it installed.
   *
   * @param {object} payload
   * @returns {object}
   */
  function intercept (payload) {
    const ctx = { ...payload }
    messagesInterceptChannel.publish(ctx)
    return ctx
  }

  const messagesArgs = [{ messages: [{ role: 'user', content: 'Hello' }] }]

  it('ignores duplicate enable and disable calls', async () => {
    const otherEvaluate = sinon.stub().resolves()
    anthropicIntegration.enable({ evaluate: otherEvaluate }, false)

    const ctx = intercept({ arguments: messagesArgs })
    await ctx.beforeResult()

    sinon.assert.calledOnce(evaluate)
    sinon.assert.notCalled(otherEvaluate)
    anthropicIntegration.disable()
    anthropicIntegration.disable()
  })

  describe('request preparation', () => {
    it('replaces the options in place with a snapshot immune to later caller mutation', () => {
      const messages = [{ role: 'user', content: 'Hello' }]
      const options = { model: 'claude-3', max_tokens: 16, system: 'Be concise', messages }
      const args = [options, { timeout: 5 }]
      const ctx = prepare(args)

      // The same array the instrumentation will spread into the SDK, with only slot 0 swapped.
      assert.strictEqual(ctx.arguments, args)
      assert.notStrictEqual(ctx.arguments[0], options)
      assert.deepStrictEqual(ctx.arguments[0], {
        model: 'claude-3',
        max_tokens: 16,
        system: 'Be concise',
        messages: [{ role: 'user', content: 'Hello' }],
      })
      assert.deepStrictEqual(ctx.arguments[1], { timeout: 5 })

      messages[0].content = 'mutated'
      assert.deepStrictEqual(ctx.arguments[0].messages, [{ role: 'user', content: 'Hello' }])
    })

    it('omits system when the caller did not supply it', () => {
      const ctx = prepare([{ model: 'claude-3', messages: [{ role: 'user', content: 'Hello' }] }])

      assert.strictEqual(Object.hasOwn(ctx.arguments[0], 'system'), false)
    })

    it('leaves the options untouched when they are not an object', () => {
      const args = ['not-an-object']
      const ctx = prepare(args)

      assert.strictEqual(ctx.arguments, args)
      assert.strictEqual(ctx.arguments[0], 'not-an-object')
    })

    it('leaves the options untouched when the input cannot be serialized', () => {
      const options = { messages: [{ role: 'user', content: 'Hello' }] }
      options.messages[0].self = options.messages[0]
      const args = [options]

      const ctx = prepare(args)
      assert.strictEqual(ctx.arguments, args)
      assert.strictEqual(ctx.arguments[0], options)
    })
  })

  it('evaluates the input messages', async () => {
    const ctx = intercept({
      arguments: [{ system: 'Be concise', messages: [{ role: 'user', content: 'Hello' }] }],
    })

    await ctx.beforeResult()

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ], EVAL_OPTS)
  })

  it('derives childOf from the operation context span', async () => {
    const span = { fake: 'anthropic.request span' }
    const ctx = intercept({
      arguments: messagesArgs,
      tracingContext: { currentStore: { span } },
    })

    await ctx.beforeResult()

    sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], {
      ...EVAL_OPTS,
      childOf: span,
    })
  })

  it('evaluates the input only once however often beforeResult runs', async () => {
    const ctx = intercept({ arguments: messagesArgs })

    await ctx.beforeResult()
    await ctx.beforeResult()

    sinon.assert.calledOnce(evaluate)
  })

  it('evaluates the input+output conversation once and returns the body', async () => {
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const ctx = intercept({ arguments: messagesArgs })

    assert.strictEqual(await ctx.onResult(body), body)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ], EVAL_OPTS)
  })

  it('evaluates model tool calls in the output', async () => {
    const ctx = intercept({ arguments: [{ messages: [{ role: 'user', content: 'find x' }] }] })

    await ctx.onResult({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
    })

    assert.deepStrictEqual(evaluate.firstCall.args[0].at(-1), {
      role: 'assistant',
      tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
    })
  })

  it('returns the body untouched when the response carries no output content', () => {
    const body = { role: 'assistant', content: [] }
    const ctx = intercept({ arguments: messagesArgs })

    assert.strictEqual(ctx.onResult(body), body)
    sinon.assert.notCalled(evaluate)
  })

  it('rejects beforeResult with the original AIGuardAbortError', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.rejects(err)
    const ctx = intercept({ arguments: messagesArgs })

    await assert.rejects(() => ctx.beforeResult(), e => e === err)
  })

  it('rejects beforeResult when evaluation throws synchronously', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.throws(err)
    const ctx = intercept({ arguments: messagesArgs })

    await assert.rejects(() => ctx.beforeResult(), e => e === err)
  })

  it('rejects onResult when the output is denied', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.rejects(err)
    const ctx = intercept({ arguments: messagesArgs })

    await assert.rejects(
      () => ctx.onResult({ role: 'assistant', content: [{ type: 'text', text: 'bad' }] }),
      e => e === err
    )
  })

  it('evaluates the output once however many readers observe it', async () => {
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const ctx = intercept({ arguments: messagesArgs })

    // `res.json()` and `clone.json()` share one interceptCtx for a single model call.
    assert.strictEqual(await ctx.onResult(body), body)
    assert.strictEqual(await ctx.onResult(body), body)

    sinon.assert.calledOnce(evaluate)
  })

  it('judges the caller options as they are when they could not be snapshotted', async () => {
    const options = { messages: [{ role: 'user', content: 'Hello' }] }
    options.messages[0].self = options.messages[0]
    const args = [options]

    prepare(args)
    assert.strictEqual(args[0], options)

    const ctx = intercept({ arguments: args })
    await ctx.beforeResult()

    sinon.assert.calledOnce(evaluate)
  })

  it('still installs callbacks for a later call that snapshots cleanly', () => {
    const circular = { role: 'user', content: 'Hello' }
    circular.self = circular
    prepare([{ messages: [circular] }])

    const ctx = intercept({ arguments: [{ messages: [{ role: 'user', content: 'Hello' }] }] })

    assert.strictEqual(typeof ctx.beforeResult, 'function')
  })

  it('delivers the body when the output conversion throws', async () => {
    const ctx = intercept({ arguments: messagesArgs })
    const body = { role: 'assistant', get content () { throw new Error('unexpected payload') } }

    assert.strictEqual(await ctx.onResult(body), body)
    sinon.assert.notCalled(evaluate)
  })

  it('installs no callbacks when there are no input messages', () => {
    const ctx = intercept({ arguments: [{}] })

    assert.strictEqual(ctx.beforeResult, undefined)
    assert.strictEqual(ctx.onResult, undefined)
  })
})
