'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { vercelAi } = require('../../../src/aiguard/integrations')
const { SOURCE_AUTO } = require('../../../src/aiguard/tags')

const modelInterceptChannel = channel('dd-trace:vercel-ai:model:intercept')

const EVAL_OPTS = { block: true, source: SOURCE_AUTO, integration: 'ai' }

function makeStream (chunks) {
  return new ReadableStream({
    start (controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function readStream (stream) {
  const chunks = []
  const reader = stream.getReader()
  function readAll () {
    return reader.read().then(({ done, value }) => {
      if (done) return chunks
      chunks.push(value)
      return readAll()
    })
  }
  return readAll()
}

describe('AIGuard Vercel AI integration', () => {
  const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]
  let evaluate

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    vercelAi.enable({ evaluate }, true)
  })

  afterEach(() => {
    vercelAi.disable()
    sinon.restore()
  })

  /**
   * Publishes what the instrumentation publishes, and returns the callbacks it installed.
   *
   * @param {string} method
   * @param {object} [options]
   * @returns {object}
   */
  function modelCall (method, options = { prompt }) {
    const ctx = { method, arguments: [options] }
    modelInterceptChannel.publish(ctx)
    return ctx
  }

  it('evaluates doGenerate input messages', async () => {
    const ctx = modelCall('doGenerate')

    await ctx.beforeResult()

    sinon.assert.calledOnceWithExactly(evaluate, [{ role: 'user', content: 'Hello' }], EVAL_OPTS)
  })

  it('delivers the result when the output conversion throws', async () => {
    const ctx = modelCall('doGenerate')
    const result = { content: 'not an array' }

    assert.strictEqual(await ctx.onResult(result), result)
    sinon.assert.notCalled(evaluate)
  })

  it('installs no callbacks when the prompt is empty', () => {
    const ctx = modelCall('doGenerate', { prompt: [] })

    assert.strictEqual(ctx.beforeResult, undefined)
    assert.strictEqual(ctx.onResult, undefined)
  })

  it('installs no callbacks when the prompt is absent', () => {
    assert.strictEqual(modelCall('doGenerate', {}).beforeResult, undefined)
  })

  it('evaluates doGenerate output messages and returns the result', async () => {
    const result = { content: [{ type: 'text', text: 'Hello!' }] }
    const ctx = modelCall('doGenerate')

    assert.strictEqual(await ctx.onResult(result), result)

    sinon.assert.calledOnceWithExactly(evaluate, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello!' },
    ], EVAL_OPTS)
  })

  it('returns the result untouched when it carries no content', () => {
    const result = { content: [] }
    const ctx = modelCall('doGenerate')

    assert.strictEqual(ctx.onResult(result), result)
    sinon.assert.notCalled(evaluate)
  })

  it('returns the result untouched when its content has nothing evaluable', () => {
    // A reasoning model returns non-empty content carrying no text or tool-call part.
    const result = { content: [{ type: 'reasoning', text: 'internal chain of thought' }] }
    const ctx = modelCall('doGenerate')

    assert.strictEqual(ctx.onResult(result), result)
    sinon.assert.notCalled(evaluate)
  })

  it('replays the stream when its chunks carry nothing evaluable', async () => {
    const chunks = [{ type: 'reasoning', text: 'internal chain of thought' }]
    const ctx = modelCall('doStream')

    const result = await ctx.onResult({ stream: makeStream(chunks) })

    assert.deepStrictEqual(await readStream(result.stream), chunks)
    sinon.assert.notCalled(evaluate)
  })

  it('rejects beforeResult with the original AIGuardAbortError', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    evaluate.rejects(err)
    const ctx = modelCall('doGenerate')

    await assert.rejects(() => ctx.beforeResult(), e => e === err)
  })

  describe('doStream', () => {
    it('drains, evaluates the accumulated text and replays every chunk', async () => {
      const chunks = [
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' world' },
      ]
      const original = { stream: makeStream(chunks), extra: 'preserved' }
      const ctx = modelCall('doStream')

      const result = await ctx.onResult(original)

      assert.notStrictEqual(result, original)
      assert.strictEqual(result.extra, 'preserved')
      assert.deepStrictEqual(await readStream(result.stream), chunks)
      sinon.assert.calledOnceWithExactly(evaluate, [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello world' },
      ], EVAL_OPTS)
    })

    it('prefers accumulated tool calls over text', async () => {
      const toolCall = { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', args: '{"q":"x"}' }
      const chunks = [{ type: 'text-delta', textDelta: 'thinking' }, toolCall]
      const ctx = modelCall('doStream')

      await ctx.onResult({ stream: makeStream(chunks) })

      assert.deepStrictEqual(evaluate.firstCall.args[0].at(-1), {
        role: 'assistant',
        tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      })
    })

    it('replays the stream when there is no evaluable content', async () => {
      const chunks = [{ type: 'finish', usage: {} }]
      const ctx = modelCall('doStream')

      const result = await ctx.onResult({ stream: makeStream(chunks) })

      assert.deepStrictEqual(await readStream(result.stream), chunks)
      sinon.assert.notCalled(evaluate)
    })

    it('delivers the original result when the stream cannot be drained', async () => {
      const stream = makeStream([{ type: 'text-delta', delta: 'hi' }])
      stream.getReader()
      const result = { stream }
      const ctx = modelCall('doStream')

      assert.strictEqual(await ctx.onResult(result), result)
      sinon.assert.notCalled(evaluate)
    })

    it('replays the read chunks and the error when the stream fails part-way', async () => {
      const err = new Error('upstream gone')
      const stream = new ReadableStream({
        start (controller) {
          controller.enqueue({ type: 'text-delta', delta: 'hi' })
          controller.error(err)
        },
      })
      const ctx = modelCall('doStream')

      const result = await ctx.onResult({ stream })

      await assert.rejects(() => readStream(result.stream), e => e === err)
      sinon.assert.notCalled(evaluate)
    })

    it('rejects when the accumulated stream output is blocked', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      evaluate.rejects(err)
      const ctx = modelCall('doStream')

      await assert.rejects(
        () => ctx.onResult({ stream: makeStream([{ type: 'text-delta', textDelta: 'bad' }]) }),
        e => e === err
      )
    })
  })
})
