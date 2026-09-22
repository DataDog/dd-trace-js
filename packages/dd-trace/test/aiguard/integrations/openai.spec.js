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

class FakeStream {
  constructor (chunks) {
    this.chunks = chunks
  }

  tee () {
    return [new FakeStream(this.chunks), new FakeStream(this.chunks)]
  }

  [Symbol.asyncIterator] () {
    let index = 0
    return {
      next: () => Promise.resolve(index < this.chunks.length
        ? { done: false, value: this.chunks[index++] }
        : { done: true, value: undefined }),
    }
  }
}

function readStream (stream) {
  const chunks = []
  const iterator = stream[Symbol.asyncIterator]()

  function readAll () {
    return iterator.next().then(({ done, value }) => {
      if (done) return chunks
      chunks.push(value)
      return readAll()
    })
  }

  return readAll()
}

describe('AIGuard OpenAI integration', () => {
  let evaluate

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    openai.enable({ evaluate }, true, true)
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

  for (const [name, interceptChannel, args, body] of [
    [
      'chat.completions',
      chatCompletionsInterceptChannel,
      [{ messages: [{ role: 'user', content: 'Hello' }] }],
      { choices: [{ message: { role: 'assistant', content: 'Hi' } }] },
    ],
    [
      'responses',
      responsesInterceptChannel,
      [{ input: 'Hello' }],
      { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] },
    ],
  ]) {
    it(`skips ${name} callbacks after the integration is disabled`, () => {
      const ctx = intercept(interceptChannel, { arguments: args })
      openai.disable()

      assert.strictEqual(ctx.beforeResult(), undefined)
      assert.strictEqual(ctx.onResult(body), body)
      sinon.assert.notCalled(evaluate)
    })
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

  describe('streamed output', () => {
    it('can disable After Model evaluation', () => {
      openai.disable()
      openai.enable({ evaluate }, true, false)
      const ctx = intercept(chatCompletionsInterceptChannel, {
        arguments: [{ messages: [{ role: 'user', content: 'Hello' }], stream: true }],
      })

      assert.strictEqual(typeof ctx.beforeResult, 'function')
      assert.strictEqual(ctx.onResult, undefined)
    })

    it('evaluates chat completion text and returns the other stream branch', async () => {
      const chunks = [
        { choices: [{ index: 0, delta: { content: 'Hello' } }] },
        { choices: [{ index: 0, delta: { content: ' world' } }] },
      ]
      const ctx = intercept(chatCompletionsInterceptChannel, {
        arguments: [{ messages: [{ role: 'user', content: 'Hi' }], stream: true }],
      })

      const result = await ctx.onResult(new FakeStream(chunks))

      assert.deepStrictEqual(await readStream(result), chunks)
      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello world' },
      ], EVAL_OPTS)
    })

    it('evaluates tool-call-only chat completion streams', async () => {
      const chunks = [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '' },
              }],
            },
          }],
        },
        {
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"unsafe"}' } }] },
          }],
        },
      ]
      const ctx = intercept(chatCompletionsInterceptChannel, {
        arguments: [{ messages: [{ role: 'user', content: 'Search' }], stream: true }],
      })

      await ctx.onResult(new FakeStream(chunks))

      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"unsafe"}' },
          }],
        },
      ], EVAL_OPTS)
    })

    it('rejects before returning a streamed tool call when After Model denies it', async () => {
      const error = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      evaluate.rejects(error)
      const chunks = [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'shell', arguments: '' },
              }],
            },
          }],
        },
        {
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"unsafe"}' } }] },
          }],
        },
      ]
      const ctx = intercept(chatCompletionsInterceptChannel, {
        arguments: [{ messages: [{ role: 'user', content: 'Run the check' }], stream: true }],
      })

      await assert.rejects(() => ctx.onResult(new FakeStream(chunks)), candidate => candidate === error)

      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Run the check' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'shell', arguments: '{"cmd":"unsafe"}' },
          }],
        },
      ], EVAL_OPTS)
    })

    it('evaluates the final Responses API snapshot', async () => {
      const chunks = [{
        type: 'response.completed',
        response: { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] },
      }]
      const ctx = intercept(responsesInterceptChannel, {
        arguments: [{ input: 'Hello', stream: true }],
      })

      const result = await ctx.onResult(new FakeStream(chunks))

      assert.deepStrictEqual(await readStream(result), chunks)
      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ], EVAL_OPTS)
    })

    it('rejects before returning a Responses API stream when After Model denies it', async () => {
      const error = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      evaluate.rejects(error)
      const chunks = [{
        type: 'response.completed',
        response: { output: [{ type: 'message', role: 'assistant', content: 'Unsafe output' }] },
      }]
      const ctx = intercept(responsesInterceptChannel, {
        arguments: [{ input: 'Hello', stream: true }],
      })

      await assert.rejects(() => ctx.onResult(new FakeStream(chunks)), candidate => candidate === error)

      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Unsafe output' },
      ], EVAL_OPTS)
    })

    it('passes through streams from SDK versions without tee()', () => {
      const stream = { [Symbol.asyncIterator]: () => {} }
      const ctx = intercept(chatCompletionsInterceptChannel, {
        arguments: [{ messages: [{ role: 'user', content: 'Hello' }], stream: true }],
      })

      assert.strictEqual(ctx.onResult(stream), stream)
      sinon.assert.notCalled(evaluate)
    })
  })
})
