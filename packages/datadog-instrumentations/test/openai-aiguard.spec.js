'use strict'

const assert = require('node:assert/strict')
const { channel, tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const chatCompletionsBeforeChannel = channel('dd-trace:openai:chat.completions:before')
const chatCompletionsAfterChannel = channel('dd-trace:openai:chat.completions:after')
const responsesBeforeChannel = channel('dd-trace:openai:responses:before')
const responsesAfterChannel = channel('dd-trace:openai:responses:after')

class FakeAPIPromise {
  constructor (body, responsePromise = Promise.resolve({ response: { headers: {}, url: '/' }, options: {} })) {
    this._body = body
    this.responsePromise = responsePromise
    this._rawResponse = { ok: true }
  }

  parse () {
    return Promise.resolve(this._body)
  }

  asResponse () {
    return Promise.resolve(this._rawResponse)
  }

  then (onFulfilled, onRejected) {
    return this.parse().then(onFulfilled, onRejected)
  }
}

class FakeUnwrappableAPIPromise extends FakeAPIPromise {
  _thenUnwrap (cb) {
    return new FakeAPIPromise(cb(this._body))
  }
}

class FakeChatCompletions {
  create () {
    return this._nextApiPromise
  }
}

class FakeResponses {
  create () {
    return this._nextApiPromise
  }
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

function subscribeWithHandler (channels, handler) {
  for (const lifecycleChannel of channels) {
    lifecycleChannel.subscribe(handler)
  }
  return () => {
    for (const lifecycleChannel of channels) {
      lifecycleChannel.unsubscribe(handler)
    }
  }
}

function lifecycleAbortError (message = 'blocked') {
  return Object.assign(new Error(message), { name: 'AIGuardAbortError' })
}

function allowLifecycle (ctx) {
  ctx.pending.push(Promise.resolve())
}

function blockLifecycle (ctx, err) {
  ctx.abortController.abort(err)
  ctx.pending.push(Promise.resolve())
}

function loadOpenAIInstrumentation () {
  const instrumentPath = require.resolve('../src/helpers/instrument')
  const realInstrument = require(instrumentPath)
  const hookCallbacks = []

  const stub = {
    ...realInstrument,
    addHook (spec, cb) {
      hookCallbacks.push({ spec, cb })
    },
  }

  const cache = require.cache[instrumentPath]
  const prevExports = cache.exports
  cache.exports = stub

  try {
    delete require.cache[require.resolve('../src/openai')]
    require('../src/openai')
  } finally {
    cache.exports = prevExports
  }

  return hookCallbacks
}

function applyShim (hookCallbacks, filePath, targetClass, TargetClass) {
  for (const { spec, cb } of hookCallbacks) {
    if (spec.file === `${filePath}.js`) {
      cb({ [targetClass]: TargetClass })
      return
    }
  }
  throw new Error(`No hook registered for ${filePath}.js`)
}

describe('openai lifecycle instrumentation', () => {
  let hookCallbacks

  before(() => {
    hookCallbacks = loadOpenAIInstrumentation()
  })

  describe('chat.completions.create', () => {
    let Completions

    beforeEach(() => {
      Completions = class extends FakeChatCompletions {}
      Completions.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/chat/completions', 'Completions', Completions)
    })

    it('calls original directly when no lifecycle subscribers exist', () => {
      const assistant = { role: 'assistant', content: 'Hello!' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(body => assert.strictEqual(body.choices[0].message, assistant))
    })

    it('finishes the span without lifecycle subscribers when only APM tracing is active', () => {
      const apmChannel = tracingChannel('apm:openai:request')
      const apmHandlers = { start () {} }
      apmChannel.subscribe(apmHandlers)

      const assistant = { role: 'assistant', content: 'Hello!' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(body => assert.strictEqual(body.choices[0].message, assistant))
        .finally(() => apmChannel.unsubscribe(apmHandlers))
    })

    it('publishes before and after lifecycle payloads with native OpenAI shapes', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([
        chatCompletionsBeforeChannel,
        chatCompletionsAfterChannel,
      ])
      const assistant = { role: 'assistant', content: 'Hello!' }
      const body = { choices: [{ message: assistant }] }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise(body)

      const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
      return completions.create(...args).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[0].args, args)
          assert.deepStrictEqual(calls[1].args, args)
          assert.strictEqual(calls[1].body, body)
          assert.ok(calls[0].abortController instanceof AbortController)
          assert.ok(Array.isArray(calls[0].pending))
          assert.strictEqual(Object.hasOwn(calls[0], 'resolve'), false)
          assert.strictEqual(Object.hasOwn(calls[0], 'reject'), false)
        })
        .finally(unsubscribe)
    })

    it('forwards the openai.request span on lifecycle payloads', () => {
      const apmChannel = tracingChannel('apm:openai:request')
      const parentSpan = { fake: 'openai.request span' }
      const apmHandlers = {
        start (ctx) {
          ctx.currentStore = { span: parentSpan }
        },
      }
      const { calls, unsubscribe } = subscribeAutoResolve([
        chatCompletionsBeforeChannel,
        chatCompletionsAfterChannel,
      ])
      apmChannel.subscribe(apmHandlers)

      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.strictEqual(calls[0].parentSpan, parentSpan)
          assert.strictEqual(calls[1].parentSpan, parentSpan)
        })
        .finally(() => {
          apmChannel.unsubscribe(apmHandlers)
          unsubscribe()
        })
    })

    it('rejects when the before lifecycle denies', () => {
      const err = lifecycleAbortError()
      const unsubscribe = subscribeWithHandler([chatCompletionsBeforeChannel], ctx => blockLifecycle(ctx, err))
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('rejects when the after lifecycle denies', () => {
      const err = lifecycleAbortError()
      const unsubscribe = subscribeWithHandler([
        chatCompletionsBeforeChannel,
        chatCompletionsAfterChannel,
      ], ctx => {
        if (ctx.body) blockLifecycle(ctx, err)
        else allowLifecycle(ctx)
      })
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('skips lifecycle channels for streaming chat.completions', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([
        chatCompletionsBeforeChannel,
        chatCompletionsAfterChannel,
      ])
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })

    it('propagates before lifecycle rejection through asResponse()', () => {
      const err = lifecycleAbortError()
      const unsubscribe = subscribeWithHandler([chatCompletionsBeforeChannel], ctx => blockLifecycle(ctx, err))
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
        e => e === err
      ).finally(unsubscribe)
    })
  })

  describe('chat.completions structured outputs (_thenUnwrap)', () => {
    let Completions

    beforeEach(() => {
      Completions = class extends FakeChatCompletions {}
      Completions.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/chat/completions', 'Completions', Completions)
    })

    it('publishes before and after lifecycle payloads when awaiting the unwrapped promise', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([
        chatCompletionsBeforeChannel,
        chatCompletionsAfterChannel,
      ])
      const body = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }
      const completions = new Completions()
      completions._nextApiPromise = new FakeUnwrappableAPIPromise(body)

      const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
      return completions.create(...args)._thenUnwrap(result => ({ ...result, parsed: { ok: true } })).parse()
        .then(result => {
          assert.strictEqual(result.parsed.ok, true)
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[0].args, args)
          assert.strictEqual(calls[1].body.parsed.ok, true)
        })
        .finally(unsubscribe)
    })
  })

  describe('responses.create', () => {
    let Responses

    beforeEach(() => {
      Responses = class extends FakeResponses {}
      Responses.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/responses/responses', 'Responses', Responses)
    })

    it('publishes before and after lifecycle payloads with native Responses API shapes', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([
        responsesBeforeChannel,
        responsesAfterChannel,
      ])
      const body = { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] }
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise(body)

      const args = [{ input: 'Hello' }]
      return responses.create(...args).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[0].args, args)
          assert.deepStrictEqual(calls[1].args, args)
          assert.strictEqual(calls[1].body, body)
        })
        .finally(unsubscribe)
    })

    it('skips lifecycle channels for streaming responses', () => {
      const { calls, unsubscribe } = subscribeAutoResolve([
        responsesBeforeChannel,
        responsesAfterChannel,
      ])
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({ input: 'hi', stream: true }).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })
  })
})
