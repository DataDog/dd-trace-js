'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { wrapModelWithAIGuard } = require('../src/ai')

const aiguardChannel = channel('dd-trace:ai:aiguard')

const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]

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

function subscribeAutoResolve () {
  const calls = []
  const handler = ctx => {
    calls.push({ phase: ctx.phase, prompt: ctx.prompt, content: ctx.content })
    ctx.resolve()
  }
  aiguardChannel.subscribe(handler)
  return { calls, unsubscribe: () => aiguardChannel.unsubscribe(handler) }
}

function subscribeAutoReject () {
  const err = Object.assign(new Error(), { name: 'AIGuardAbortError', reason: 'blocked' })
  const handler = ctx => ctx.reject(err)
  aiguardChannel.subscribe(handler)
  return { err, unsubscribe: () => aiguardChannel.unsubscribe(handler) }
}

describe('wrapModelWithAIGuard', () => {
  let model

  beforeEach(() => {
    model = {}
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('doGenerate', () => {
    it('calls original directly when no subscribers', () => {
      const result = { content: [] }
      const original = sinon.stub().resolves(result)
      model.doGenerate = original
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt }).then(r => {
        assert.strictEqual(r, result)
        sinon.assert.calledOnce(original)
      })
    })

    it('calls original directly when prompt is empty', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt: [] })
        .then(() => sinon.assert.calledOnce(original))
        .finally(unsubscribe)
    })

    it('calls original directly when prompt is absent', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithAIGuard(model)

      return model.doGenerate({})
        .then(() => sinon.assert.calledOnce(original))
        .finally(unsubscribe)
    })

    it('publishes input evaluation before calling original', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      let evaluatedBeforeOriginal = false
      const original = sinon.stub().callsFake(() => {
        evaluatedBeforeOriginal = calls.length === 1
        return Promise.resolve({ content: [] })
      })
      model.doGenerate = original
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 1)
          assert.strictEqual(calls[0].phase, 'input')
          assert.deepStrictEqual(calls[0].prompt, prompt)
          assert.strictEqual(evaluatedBeforeOriginal, true)
        })
        .finally(unsubscribe)
    })

    it('does not call original when input is rejected', () => {
      const { err, unsubscribe } = subscribeAutoReject()
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithAIGuard(model)

      return assert.rejects(() => model.doGenerate({ prompt }), e => e === err)
        .then(() => sinon.assert.notCalled(original))
        .finally(unsubscribe)
    })

    it('publishes output evaluation with text content', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const content = [{ type: 'text', text: 'Hello!' }]
      model.doGenerate = sinon.stub().resolves({ content })
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.strictEqual(calls[1].phase, 'output')
          assert.deepStrictEqual(calls[1].prompt, prompt)
          assert.deepStrictEqual(calls[1].content, content)
        })
        .finally(unsubscribe)
    })

    it('publishes output evaluation with tool call content', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const content = [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'test' } }]
      model.doGenerate = sinon.stub().resolves({ content })
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.strictEqual(calls[1].phase, 'output')
          assert.deepStrictEqual(calls[1].content, content)
        })
        .finally(unsubscribe)
    })

    it('skips output evaluation when content is empty', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      model.doGenerate = sinon.stub().resolves({ content: [] })
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('skips output evaluation when content is absent', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      model.doGenerate = sinon.stub().resolves({})
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('returns original result after output evaluation', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const content = [{ type: 'text', text: 'reply' }]
      const expected = { content, usage: { tokens: 10 } }
      model.doGenerate = sinon.stub().resolves(expected)
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(result => assert.strictEqual(result, expected))
        .finally(unsubscribe)
    })

    it('rejects when output evaluation rejects', () => {
      let callCount = 0
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const handler = ctx => {
        callCount++
        callCount === 1 ? ctx.resolve() : ctx.reject(err)
      }
      aiguardChannel.subscribe(handler)
      model.doGenerate = sinon.stub().resolves({ content: [{ type: 'text', text: 'bad' }] })
      wrapModelWithAIGuard(model)

      return assert.rejects(() => model.doGenerate({ prompt }), e => e === err)
        .finally(() => aiguardChannel.unsubscribe(handler))
    })

    it('does not wrap already wrapped model', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      model.doGenerate = sinon.stub().resolves({ content: [] })
      wrapModelWithAIGuard(model)
      wrapModelWithAIGuard(model)

      return model.doGenerate({ prompt })
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })
  })

  describe('doStream', () => {
    it('calls original directly when no subscribers', () => {
      const stream = makeStream([])
      const original = sinon.stub().resolves({ stream })
      model.doStream = original
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt }).then(result => {
        assert.ok(result.stream)
        sinon.assert.calledOnce(original)
      })
    })

    it('calls original directly when prompt is empty', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const original = sinon.stub().resolves({ stream: makeStream([]) })
      model.doStream = original
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt: [] })
        .then(() => sinon.assert.calledOnce(original))
        .finally(unsubscribe)
    })

    it('publishes input evaluation before reading stream', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      model.doStream = sinon.stub().resolves({ stream: makeStream([]) })
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.strictEqual(calls[0].phase, 'input')
          assert.deepStrictEqual(calls[0].prompt, prompt)
        })
        .finally(unsubscribe)
    })

    it('rejects when input is rejected without calling original', () => {
      const { err, unsubscribe } = subscribeAutoReject()
      const original = sinon.stub()
      model.doStream = original
      wrapModelWithAIGuard(model)

      return assert.rejects(() => model.doStream({ prompt }), e => e === err)
        .then(() => sinon.assert.notCalled(original))
        .finally(unsubscribe)
    })

    it('replays all collected chunks in the output stream', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const chunks = [
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' World' },
        { type: 'finish' },
      ]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt })
        .then(result => readStream(result.stream))
        .then(received => assert.deepStrictEqual(received, chunks))
        .finally(unsubscribe)
    })

    it('publishes output evaluation with accumulated text', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const chunks = [
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' World' },
        { type: 'finish' },
      ]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.strictEqual(calls[1].phase, 'output')
          assert.deepStrictEqual(calls[1].content, [{ type: 'text', text: 'Hello World' }])
        })
        .finally(unsubscribe)
    })

    it('publishes output evaluation with all collected tool calls', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const tc1 = { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'a' } }
      const tc2 = { type: 'tool-call', toolCallId: 'c2', toolName: 'fetch', args: { url: 'x' } }
      const chunks = [tc1, tc2, { type: 'finish' }]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.strictEqual(calls[1].phase, 'output')
          assert.deepStrictEqual(calls[1].content, [tc1, tc2])
        })
        .finally(unsubscribe)
    })

    it('prefers tool calls over text when both present', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const tc = { type: 'tool-call', toolCallId: 'c1', toolName: 'action', args: {} }
      const chunks = [{ type: 'text-delta', textDelta: 'some text' }, tc, { type: 'finish' }]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.deepStrictEqual(calls[1].content, [tc])
        })
        .finally(unsubscribe)
    })

    it('skips output evaluation when stream has no text or tool calls', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      model.doStream = sinon.stub().resolves({ stream: makeStream([{ type: 'finish' }]) })
      wrapModelWithAIGuard(model)

      return model.doStream({ prompt })
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('rejects when output evaluation rejects', () => {
      let callCount = 0
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const handler = ctx => {
        callCount++
        callCount === 1 ? ctx.resolve() : ctx.reject(err)
      }
      aiguardChannel.subscribe(handler)
      const chunks = [{ type: 'text-delta', textDelta: 'bad response' }, { type: 'finish' }]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithAIGuard(model)

      return assert.rejects(() => model.doStream({ prompt }), e => e === err)
        .finally(() => aiguardChannel.unsubscribe(handler))
    })
  })
})
