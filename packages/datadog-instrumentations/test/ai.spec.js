'use strict'

const assert = require('node:assert/strict')
const { channel, tracingChannel } = require('dc-polyfill')
const { afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { createDelegatingSpan, wrapModelWithLifecycle } = require('../src/ai')

const doGenerateBeforeChannel = channel('dd-trace:vercel-ai:doGenerate:before')
const doGenerateAfterChannel = channel('dd-trace:vercel-ai:doGenerate:after')
const doStreamBeforeChannel = channel('dd-trace:vercel-ai:doStream:before')
const doStreamAfterChannel = channel('dd-trace:vercel-ai:doStream:after')

const vercelAiTracingChannel = tracingChannel('dd-trace:vercel-ai')
const vercelAiSpanSetAttributesChannel = channel('dd-trace:vercel-ai:span:setAttributes')

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

describe('createDelegatingSpan', () => {
  const { ERROR_MESSAGE, IGNORE_OTEL_ERROR } = require('../../dd-trace/src/constants')

  // OTel SpanStatusCode: UNSET = 0, OK = 1, ERROR = 2.
  const OTEL_STATUS_OK = 1
  const OTEL_STATUS_ERROR = 2

  let ctx

  beforeEach(() => {
    ctx = { name: 'ai.generateText', attributes: {} }
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('with a real OTel-bridge span (private #statusCode field)', () => {
    let TracerProvider
    let span

    before(() => {
      require('../../dd-trace').init()
      TracerProvider = require('../../dd-trace/src/opentelemetry/tracer_provider')
    })

    beforeEach(() => {
      const provider = new TracerProvider()
      provider.register()
      span = provider.getTracer().startSpan('ai.generateText')
    })

    afterEach(() => {
      span.end()
    })

    // Regression: Object.create(span) produced a prototype clone that did not carry the
    // bridge span's #statusCode private-field brand, so setStatus() threw
    // "Cannot read private member #statusCode from an object whose class did not declare it".
    // The delegating wrapper forwards to the real instance, so the brand check passes.
    it('records an ERROR status on the underlying span without throwing', () => {
      const delegatingSpan = createDelegatingSpan(span, ctx)

      // Under the old Object.create clone this threw the "Cannot read private member #statusCode"
      // TypeError; the subsequent tag assertions confirm the status was recorded on the real span.
      delegatingSpan.setStatus({ code: OTEL_STATUS_ERROR, message: 'boom' })

      const spanContext = span._ddSpan.context()
      assert.strictEqual(spanContext.getTag(ERROR_MESSAGE), 'boom')
      assert.strictEqual(spanContext.getTag(IGNORE_OTEL_ERROR), false)
    })

    it('delegates the full status precedence (OK is final) to the underlying span', () => {
      const delegatingSpan = createDelegatingSpan(span, ctx)

      delegatingSpan.setStatus({ code: OTEL_STATUS_OK })
      // OK is final per the OTel spec, so a subsequent ERROR must not overwrite it.
      delegatingSpan.setStatus({ code: OTEL_STATUS_ERROR, message: 'boom' })

      assert.strictEqual(span._ddSpan.context().getTag(ERROR_MESSAGE), undefined)
    })

    it('returns the wrapper (not the underlying span) from setter methods for OTel chaining', () => {
      const delegatingSpan = createDelegatingSpan(span, ctx)

      assert.strictEqual(delegatingSpan.setStatus({ code: OTEL_STATUS_OK }), delegatingSpan)
      assert.strictEqual(delegatingSpan.setAttribute('ai.request.model', 'gpt-4o-mini'), delegatingSpan)
      assert.strictEqual(delegatingSpan.setAttributes({ 'ai.request.model': 'gpt-4o-mini' }), delegatingSpan)
    })
  })

  describe('pass-through delegation', () => {
    it('delegates non-publishing Span methods to the underlying receiver', () => {
      const calls = {}
      const spanContext = { traceId: 'trace-id', spanId: 'span-id', traceFlags: 1 }

      function recordCall (method, result) {
        return function (...args) {
          calls[method] = { receiver: this, args }
          return result
        }
      }

      const span = {
        spanContext: recordCall('spanContext', spanContext),
        addEvent: recordCall('addEvent'),
        addLink: recordCall('addLink'),
        addLinks: recordCall('addLinks'),
        updateName: recordCall('updateName'),
        isRecording: recordCall('isRecording', true),
      }
      const delegatingSpan = createDelegatingSpan(span, ctx)
      const eventAttributes = { type: 'test' }
      const link = { context: spanContext, attributes: { type: 'parent' } }
      const links = [link]

      assert.strictEqual(delegatingSpan.spanContext(), spanContext)
      assert.strictEqual(delegatingSpan.addEvent('event', eventAttributes, 123), delegatingSpan)
      assert.strictEqual(delegatingSpan.addLink(link), delegatingSpan)
      assert.strictEqual(delegatingSpan.addLinks(links), delegatingSpan)
      assert.strictEqual(delegatingSpan.updateName('renamed'), delegatingSpan)
      assert.strictEqual(delegatingSpan.isRecording(), true)

      for (const call of Object.values(calls)) {
        assert.strictEqual(call.receiver, span)
      }
      assert.deepStrictEqual(calls.spanContext.args, [])
      assert.deepStrictEqual(calls.addEvent.args, ['event', eventAttributes, 123])
      assert.deepStrictEqual(calls.addLink.args, [link])
      assert.deepStrictEqual(calls.addLinks.args, [links])
      assert.deepStrictEqual(calls.updateName.args, ['renamed'])
      assert.deepStrictEqual(calls.isRecording.args, [])
    })
  })

  describe('channel publication and delegation', () => {
    // Underlying span whose methods record the receiver so we can prove `this === span`
    // (private-field brand preservation) and that delegation happens after publishing.
    function makeRecordingSpan () {
      const receivers = {}
      const span = {
        end (...args) { receivers.end = this; this.endArgs = args },
        setAttributes (attributes) { receivers.setAttributes = this; this.attributes = attributes },
        recordException (exception) { receivers.recordException = this; this.exception = exception },
      }
      return { span, receivers }
    }

    it('publishes asyncEnd and delegates end() to the underlying span', () => {
      const asyncEnd = sinon.spy()
      vercelAiTracingChannel.asyncEnd.subscribe(asyncEnd)

      try {
        const { span, receivers } = makeRecordingSpan()
        const delegatingSpan = createDelegatingSpan(span, ctx)

        delegatingSpan.end(123)

        sinon.assert.calledOnceWithExactly(asyncEnd, ctx, 'tracing:dd-trace:vercel-ai:asyncEnd')
        assert.strictEqual(receivers.end, span)
        assert.deepStrictEqual(span.endArgs, [123])
      } finally {
        vercelAiTracingChannel.asyncEnd.unsubscribe(asyncEnd)
      }
    })

    it('publishes { ctx, attributes } and delegates setAttributes() to the underlying span', () => {
      const onSetAttributes = sinon.spy()
      vercelAiSpanSetAttributesChannel.subscribe(onSetAttributes)

      try {
        const { span, receivers } = makeRecordingSpan()
        const delegatingSpan = createDelegatingSpan(span, ctx)
        const attributes = { 'ai.request.model': 'gpt-4o-mini' }

        delegatingSpan.setAttributes(attributes)

        sinon.assert.calledOnceWithExactly(
          onSetAttributes,
          { ctx, attributes },
          'dd-trace:vercel-ai:span:setAttributes'
        )
        assert.strictEqual(receivers.setAttributes, span)
        assert.strictEqual(span.attributes, attributes)
      } finally {
        vercelAiSpanSetAttributesChannel.unsubscribe(onSetAttributes)
      }
    })

    it('sets ctx.error, publishes error, and delegates recordException() to the underlying span', () => {
      const onError = sinon.spy()
      vercelAiTracingChannel.error.subscribe(onError)

      try {
        const { span, receivers } = makeRecordingSpan()
        const delegatingSpan = createDelegatingSpan(span, ctx)
        const exception = new Error('boom')

        delegatingSpan.recordException(exception)

        assert.strictEqual(ctx.error, exception)
        sinon.assert.calledOnceWithExactly(onError, ctx, 'tracing:dd-trace:vercel-ai:error')
        assert.strictEqual(receivers.recordException, span)
        assert.strictEqual(span.exception, exception)
      } finally {
        vercelAiTracingChannel.error.unsubscribe(onError)
      }
    })
  })
})
