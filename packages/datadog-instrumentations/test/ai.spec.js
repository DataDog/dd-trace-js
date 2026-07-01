'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { wrapModelWithLifecycle, wrapTracer } = require('../src/ai')

const doGenerateBeforeChannel = channel('dd-trace:vercel-ai:doGenerate:before')
const doGenerateAfterChannel = channel('dd-trace:vercel-ai:doGenerate:after')
const doStreamBeforeChannel = channel('dd-trace:vercel-ai:doStream:before')
const doStreamAfterChannel = channel('dd-trace:vercel-ai:doStream:after')

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

function subscribeAutoResolve (channels) {
  const calls = []
  const handler = ctx => {
    calls.push(ctx)
    ctx.pending.push(Promise.resolve())
  }
  for (const lifecycleChannel of channels) {
    lifecycleChannel.subscribe(handler)
  }
  return {
    calls,
    unsubscribe: () => {
      for (const lifecycleChannel of channels) {
        lifecycleChannel.unsubscribe(handler)
      }
    },
  }
}

function subscribeAutoReject (channels) {
  const err = Object.assign(new Error(), { name: 'AIGuardAbortError', reason: 'blocked' })
  const handler = ctx => {
    ctx.abortController.abort(err)
    ctx.pending.push(Promise.resolve())
  }
  for (const lifecycleChannel of channels) {
    lifecycleChannel.subscribe(handler)
  }
  return {
    err,
    unsubscribe: () => {
      for (const lifecycleChannel of channels) {
        lifecycleChannel.unsubscribe(handler)
      }
    },
  }
}

function subscribeSyncAbort (channels) {
  const err = Object.assign(new Error(), { name: 'AIGuardAbortError', reason: 'blocked' })
  const handler = ctx => ctx.abortController.abort(err)
  for (const lifecycleChannel of channels) {
    lifecycleChannel.subscribe(handler)
  }
  return {
    err,
    unsubscribe: () => {
      for (const lifecycleChannel of channels) {
        lifecycleChannel.unsubscribe(handler)
      }
    },
  }
}

function subscribeAbortOnCall (channels, abortOnCall, err) {
  let callCount = 0
  const handler = ctx => {
    callCount++
    if (callCount === abortOnCall) ctx.abortController.abort(err)
    ctx.pending.push(Promise.resolve())
  }
  for (const lifecycleChannel of channels) {
    lifecycleChannel.subscribe(handler)
  }
  return () => {
    for (const lifecycleChannel of channels) {
      lifecycleChannel.unsubscribe(handler)
    }
  }
}

describe('wrapModelWithLifecycle', () => {
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
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt }).then(r => {
        assert.strictEqual(r, result)
        sinon.assert.calledOnce(original)
      })
    })

    it('calls original directly when prompt is empty', () => {
      const { unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel])
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt: [] })
        .then(() => sinon.assert.calledOnce(original))
        .finally(unsubscribe)
    })

    it('calls original directly when prompt is absent', () => {
      const { unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel])
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithLifecycle(model)

      return model.doGenerate({})
        .then(() => sinon.assert.calledOnce(original))
        .finally(unsubscribe)
    })

    it('publishes input evaluation in parallel with LLM call', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel])
      let llmCalledBeforeGuardResolves = false
      const original = sinon.stub().callsFake(() => {
        llmCalledBeforeGuardResolves = calls.length === 0 || calls.length === 1
        return Promise.resolve({ content: [] })
      })
      model.doGenerate = original
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 1)
          assert.deepStrictEqual(calls[0].prompt, prompt)
          assert.deepStrictEqual(calls[0].options, { prompt })
          assert.ok(calls[0].abortController instanceof AbortController)
          assert.ok(Array.isArray(calls[0].pending))
          assert.strictEqual(Object.hasOwn(calls[0], 'resolve'), false)
          assert.strictEqual(Object.hasOwn(calls[0], 'reject'), false)
          assert.strictEqual(llmCalledBeforeGuardResolves, true)
          sinon.assert.calledOnce(original)
        })
        .finally(unsubscribe)
    })

    it('rejects with guard error when input is rejected', () => {
      const { err, unsubscribe } = subscribeAutoReject([doGenerateBeforeChannel])
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithLifecycle(model)

      return assert.rejects(() => model.doGenerate({ prompt }), e => e === err)
        .finally(unsubscribe)
    })

    it('rejects when input evaluation aborts synchronously without pending work', () => {
      const { err, unsubscribe } = subscribeSyncAbort([doGenerateBeforeChannel])
      const original = sinon.stub().resolves({ content: [] })
      model.doGenerate = original
      wrapModelWithLifecycle(model)

      return assert.rejects(() => model.doGenerate({ prompt }), e => e === err)
        .finally(unsubscribe)
    })

    it('publishes output evaluation with text content', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel, doGenerateAfterChannel])
      const content = [{ type: 'text', text: 'Hello!' }]
      model.doGenerate = sinon.stub().resolves({ content })
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].prompt, prompt)
          assert.deepStrictEqual(calls[1].result, { content })
          assert.strictEqual(calls[1].abortController.signal.aborted, false)
        })
        .finally(unsubscribe)
    })

    it('publishes output evaluation with tool call content', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel, doGenerateAfterChannel])
      const content = [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'test' } }]
      model.doGenerate = sinon.stub().resolves({ content })
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].result, { content })
        })
        .finally(unsubscribe)
    })

    it('skips output evaluation when content is empty', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel, doGenerateAfterChannel])
      model.doGenerate = sinon.stub().resolves({ content: [] })
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt })
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('skips output evaluation when content is absent', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel, doGenerateAfterChannel])
      model.doGenerate = sinon.stub().resolves({})
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt })
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('returns original result after output evaluation', () => {
      const { unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel, doGenerateAfterChannel])
      const content = [{ type: 'text', text: 'reply' }]
      const expected = { content, usage: { tokens: 10 } }
      model.doGenerate = sinon.stub().resolves(expected)
      wrapModelWithLifecycle(model)

      return model.doGenerate({ prompt })
        .then(result => assert.strictEqual(result, expected))
        .finally(unsubscribe)
    })

    it('rejects when output evaluation rejects', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeAbortOnCall([doGenerateBeforeChannel, doGenerateAfterChannel], 2, err)
      model.doGenerate = sinon.stub().resolves({ content: [{ type: 'text', text: 'bad' }] })
      wrapModelWithLifecycle(model)

      return assert.rejects(() => model.doGenerate({ prompt }), e => e === err)
        .finally(unsubscribe)
    })

    it('does not wrap already wrapped model', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doGenerateBeforeChannel])
      model.doGenerate = sinon.stub().resolves({ content: [] })
      wrapModelWithLifecycle(model)
      wrapModelWithLifecycle(model)

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
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt }).then(result => {
        assert.ok(result.stream)
        sinon.assert.calledOnce(original)
      })
    })

    it('calls original directly when prompt is empty', () => {
      const { unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel])
      const original = sinon.stub().resolves({ stream: makeStream([]) })
      model.doStream = original
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt: [] })
        .then(() => sinon.assert.calledOnce(original))
        .finally(unsubscribe)
    })

    it('publishes input evaluation in parallel with LLM call', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel])
      model.doStream = sinon.stub().resolves({ stream: makeStream([]) })
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.deepStrictEqual(calls[0].prompt, prompt)
        })
        .finally(unsubscribe)
    })

    it('rejects with guard error when input is rejected', () => {
      const { err, unsubscribe } = subscribeAutoReject([doStreamBeforeChannel])
      const original = sinon.stub().resolves({ stream: makeStream([]) })
      model.doStream = original
      wrapModelWithLifecycle(model)

      return assert.rejects(() => model.doStream({ prompt }), e => e === err)
        .finally(unsubscribe)
    })

    it('replays all collected chunks in the output stream', () => {
      const { unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel, doStreamAfterChannel])
      const chunks = [
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' World' },
        { type: 'finish' },
      ]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt })
        .then(result => readStream(result.stream))
        .then(received => assert.deepStrictEqual(received, chunks))
        .finally(unsubscribe)
    })

    it('publishes output evaluation with accumulated text', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel, doStreamAfterChannel])
      const chunks = [
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' World' },
        { type: 'finish' },
      ]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].prompt, prompt)
          assert.deepStrictEqual(calls[1].chunks, chunks)
        })
        .finally(unsubscribe)
    })

    it('publishes output evaluation with all collected tool calls', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel, doStreamAfterChannel])
      const tc1 = { type: 'tool-call', toolCallId: 'c1', toolName: 'search', args: { q: 'a' } }
      const tc2 = { type: 'tool-call', toolCallId: 'c2', toolName: 'fetch', args: { url: 'x' } }
      const chunks = [tc1, tc2, { type: 'finish' }]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].chunks, chunks)
        })
        .finally(unsubscribe)
    })

    it('prefers tool calls over text when both present', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel, doStreamAfterChannel])
      const tc = { type: 'tool-call', toolCallId: 'c1', toolName: 'action', args: {} }
      const chunks = [{ type: 'text-delta', textDelta: 'some text' }, tc, { type: 'finish' }]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt })
        .then(() => {
          assert.deepStrictEqual(calls[1].chunks, chunks)
        })
        .finally(unsubscribe)
    })

    it('skips output evaluation when stream has no text or tool calls', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([doStreamBeforeChannel, doStreamAfterChannel])
      model.doStream = sinon.stub().resolves({ stream: makeStream([{ type: 'finish' }]) })
      wrapModelWithLifecycle(model)

      return model.doStream({ prompt })
        .then(() => assert.strictEqual(calls.length, 2))
        .finally(unsubscribe)
    })

    it('rejects when output evaluation rejects', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeAbortOnCall([doStreamBeforeChannel, doStreamAfterChannel], 2, err)
      const chunks = [{ type: 'text-delta', textDelta: 'bad response' }, { type: 'finish' }]
      model.doStream = sinon.stub().resolves({ stream: makeStream(chunks) })
      wrapModelWithLifecycle(model)

      return assert.rejects(() => model.doStream({ prompt }), e => e === err)
        .finally(unsubscribe)
    })
  })
})

describe('wrapTracer', () => {
  // Regression: Object.create(span) strips the private-field brand from BridgeSpanBase spans,
  // so any method that reads #statusCode (e.g. setStatus) would throw
  // "Cannot read/write private member #statusCode from an object whose class did not declare it".
  // The fix uses a plain delegating wrapper that always calls through to the real span instance.
  it('forwards setStatus to the original span without throwing for private-field spans', () => {
    class PrivateFieldSpan {
      #statusCode = 0

      spanContext () { return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 } }
      setAttribute () { return this }
      setAttributes () { return this }
      addEvent () { return this }
      addLink () { return this }
      addLinks () { return this }
      setStatus (s) { this.#statusCode = s.code; return this }
      updateName () { return this }
      end () { return this }
      isRecording () { return true }
      recordException () { return this }
    }

    const span = new PrivateFieldSpan()
    const tracer = {
      startActiveSpan (name, fn) { return fn(span) },
    }

    wrapTracer(tracer)

    assert.doesNotThrow(() => {
      tracer.startActiveSpan('test', (freshSpan) => {
        freshSpan.setStatus({ code: 2 }) // SpanStatusCode.ERROR
        freshSpan.end()
      })
    })
  })

  it('returns freshSpan from chainable methods so chained end() is not bypassed', () => {
    const endSpy = sinon.spy()
    const span = {
      spanContext () { return { traceId: '', spanId: '', traceFlags: 0 } },
      setAttribute () { return this },
      setAttributes () { return this },
      addEvent () { return this },
      addLink () { return this },
      addLinks () { return this },
      setStatus () { return this },
      updateName () { return this },
      end: endSpy,
      isRecording () { return false },
      recordException () {},
    }
    const tracer = {
      startActiveSpan (name, fn) { return fn(span) },
    }

    wrapTracer(tracer)

    tracer.startActiveSpan('test', (freshSpan) => {
      const returned = freshSpan.setStatus({ code: 0 })
      assert.strictEqual(returned, freshSpan, 'setStatus must return freshSpan to preserve chaining')
      returned.end()
      sinon.assert.calledOnce(endSpy)
    })
  })
})
