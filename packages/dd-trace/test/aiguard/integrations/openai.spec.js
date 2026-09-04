'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { openai } = require('../../../src/aiguard/integrations')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = channel('dd-trace:openai:responses:intercept')

const EVAL_OPTS = { block: true, source: SOURCE_AUTO, integration: 'openai' }

describe('AIGuard OpenAI integration', () => {
  let evaluate

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    openai.enable({ evaluate }, true)
  })

  afterEach(() => {
    openai.disable()
    sinon.restore()
  })

  /**
   * Publishes what the instrumentation publishes, and returns the callbacks it installed.
   *
   * @param {object} interceptChannel
   * @param {object} payload
   * @returns {object}
   */
  function intercept (interceptChannel, payload) {
    const ctx = { ...payload }
    interceptChannel.publish(ctx)
    return ctx
  }

  describe('chat.completions', () => {
    const args = [{ messages: [{ role: 'user', content: 'Hello' }] }]

    it('installs both callbacks for a guarded call', () => {
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      assert.strictEqual(typeof ctx.beforeResult, 'function')
      assert.strictEqual(typeof ctx.onResult, 'function')
      sinon.assert.notCalled(evaluate)
    })

    it('evaluates the input when beforeResult runs', async () => {
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      await ctx.beforeResult()

      sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], EVAL_OPTS)
    })

    it('derives childOf from the operation context span', async () => {
      const span = { fake: 'openai.request span' }
      const ctx = intercept(chatCompletionsInterceptChannel, {
        arguments: args,
        tracingContext: { currentStore: { span } },
      })

      await ctx.beforeResult()

      sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], {
        ...EVAL_OPTS,
        childOf: span,
      })
    })

    it('evaluates the input only once however often beforeResult runs', async () => {
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      await ctx.beforeResult()
      await ctx.beforeResult()

      sinon.assert.calledOnce(evaluate)
    })

    it('rejects beforeResult with the original AIGuardAbortError', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      evaluate.rejects(err)
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      await assert.rejects(() => ctx.beforeResult(), e => e === err)
    })

    it('rejects beforeResult when evaluation throws synchronously', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      evaluate.throws(err)
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      await assert.rejects(() => ctx.beforeResult(), e => e === err)
    })

    it('fails open when evaluation errors unexpectedly', async () => {
      evaluate.rejects(new Error('service unavailable'))
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      await ctx.beforeResult()
    })

    it('fails open when evaluation throws unexpectedly and synchronously', async () => {
      evaluate.throws(new Error('service unavailable'))
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      // Resolving rather than rejecting is what lets the call through.
      await ctx.beforeResult()
    })

    it('evaluates every output choice independently and returns the body', async () => {
      const body = {
        choices: [
          { message: { role: 'assistant', content: 'one' } },
          { message: { role: 'assistant', content: 'two' } },
        ],
      }
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      assert.strictEqual(await ctx.onResult(body), body)

      assert.strictEqual(evaluate.callCount, 2)
      assert.deepStrictEqual(evaluate.firstCall.args[0], [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'one' },
      ])
      assert.deepStrictEqual(evaluate.secondCall.args[0], [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'two' },
      ])
    })

    it('evaluates the output once however many readers observe it', async () => {
      const body = { choices: [{ message: { role: 'assistant', content: 'Hi' } }] }
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      // Awaiting the same APIPromise twice runs `parse`, and so `onResult`, twice.
      assert.strictEqual(await ctx.onResult(body), body)
      assert.strictEqual(await ctx.onResult(body), body)

      sinon.assert.calledOnce(evaluate)
    })

    it('rejects onResult when the output is denied', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      evaluate.rejects(err)
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      await assert.rejects(
        () => ctx.onResult({ choices: [{ message: { role: 'assistant', content: 'bad' } }] }),
        e => e === err
      )
    })

    it('delivers the body when the output conversion throws', async () => {
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })
      const body = { get choices () { throw new Error('unexpected payload') } }

      assert.strictEqual(await ctx.onResult(body), body)
      sinon.assert.notCalled(evaluate)
    })

    it('returns the body untouched when it carries no output messages', () => {
      const body = { choices: [] }
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: args })

      assert.strictEqual(ctx.onResult(body), body)
      sinon.assert.notCalled(evaluate)
    })

    it('installs no callbacks when there are no input messages', () => {
      const ctx = intercept(chatCompletionsInterceptChannel, { arguments: [{}] })

      assert.strictEqual(ctx.beforeResult, undefined)
      assert.strictEqual(ctx.onResult, undefined)
    })
  })

  describe('responses', () => {
    it('evaluates the input messages', async () => {
      const ctx = intercept(responsesInterceptChannel, {
        arguments: [{ instructions: 'Be concise', input: 'Hello' }],
      })

      await ctx.beforeResult()

      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'developer', content: 'Be concise' },
        { role: 'user', content: 'Hello' },
      ], EVAL_OPTS)
    })

    it('evaluates the output as one conversation', async () => {
      const body = { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] }
      const ctx = intercept(responsesInterceptChannel, { arguments: [{ input: 'Hello' }] })

      assert.strictEqual(await ctx.onResult(body), body)

      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ], EVAL_OPTS)
    })

    it('evaluates the output once however many readers observe it', async () => {
      const body = { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] }
      const ctx = intercept(responsesInterceptChannel, { arguments: [{ input: 'Hello' }] })

      assert.strictEqual(await ctx.onResult(body), body)
      assert.strictEqual(await ctx.onResult(body), body)

      sinon.assert.calledOnce(evaluate)
    })
  })
})
