'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const aiguardChannel = channel('dd-trace:ai:aiguard')

// Minimal APIPromise stand-in. The real SDK APIPromise has a `parse()` method that
// returns the parsed response body, and user-facing `.then` routes through `.parse()`.
// The instrumentation patches `parse()` rather than `then()` to preserve the APIPromise
// surface (`.withResponse()` etc.).
class FakeAPIPromise {
  constructor (body, responsePromise = Promise.resolve({ response: { headers: {}, url: '/' }, options: {} })) {
    this._body = body
    this.responsePromise = responsePromise
  }

  parse () {
    return Promise.resolve(this._body)
  }

  then (onFulfilled, onRejected) {
    return this.parse().then(onFulfilled, onRejected)
  }
}

// Variant that exposes `_thenUnwrap`, used by the `client.beta.chat.completions.parse`
// structured-output code path. `_thenUnwrap(cb)` returns a new APIPromise whose `parse`
// yields the transformed body; users await this inner promise, not the outer one.
class FakeUnwrappableAPIPromise extends FakeAPIPromise {
  _thenUnwrap (cb) {
    const inner = new FakeAPIPromise(cb(this._body))
    return inner
  }
}

// Mirrors the shape of the target classes that openai.js patches so we can require the
// instrumentation and then reach in to the wrapped prototype methods directly.
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

function subscribeAutoResolve () {
  const calls = []
  const handler = ctx => {
    calls.push({ messages: ctx.messages })
    ctx.resolve()
  }
  aiguardChannel.subscribe(handler)
  return { calls, unsubscribe: () => aiguardChannel.unsubscribe(handler) }
}

function subscribeWithHandler (handler) {
  aiguardChannel.subscribe(handler)
  return () => aiguardChannel.unsubscribe(handler)
}

/**
 * Loads the openai instrumentation with a stubbed `addHook` so we capture the exports-
 * transform callbacks. We then invoke them against fake prototypes to apply the shims.
 */
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
  // Match the canonical .js hook registration only; we do not want to wrap the same
  // prototype twice via the .mjs alias or overlap with version-gated file variants.
  for (const { spec, cb } of hookCallbacks) {
    if (spec.file === `${filePath}.js`) {
      cb({ [targetClass]: TargetClass })
      return
    }
  }
  throw new Error(`No hook registered for ${filePath}.js`)
}

describe('openai AI Guard instrumentation', () => {
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

    it('calls original directly when no AI Guard subscribers', () => {
      const assistant = { role: 'assistant', content: 'Hello!' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(body => assert.strictEqual(body.choices[0].message, assistant))
    })

    it('calls original directly when messages are missing', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return completions.create({}).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })

    it('publishes Before Model evaluation with converted input messages', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const assistant = { role: 'assistant', content: 'Hello!' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      const messages = [{ role: 'user', content: 'Hi' }]
      return completions.create({ messages }).parse()
        .then(() => {
          assert.ok(calls.length >= 1)
          assert.deepStrictEqual(calls[0].messages, messages)
        })
        .finally(unsubscribe)
    })

    it('publishes After Model evaluation including the assistant response', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const assistant = { role: 'assistant', content: 'Hello!' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      const messages = [{ role: 'user', content: 'Hi' }]
      return completions.create({ messages }).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].messages, [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
          ])
        })
        .finally(unsubscribe)
    })

    it('publishes After Model evaluation including assistant tool_calls', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const toolCalls = [{ id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }]
      const assistant = { role: 'assistant', tool_calls: toolCalls }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].messages[1].tool_calls, toolCalls)
        })
        .finally(unsubscribe)
    })

    it('skips After Model when the response has no assistant message', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('rejects with the AI Guard error when Before Model denies', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => ctx.reject(err))
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('rejects with the AI Guard error when After Model denies', () => {
      let count = 0
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => {
        count++
        count === 1 ? ctx.resolve() : ctx.reject(err)
      })
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('kicks off Before Model evaluation before waiting for the LLM response', () => {
      // The timing proof: the publish channel handler runs synchronously when we call
      // publishToAIGuard, which happens right after methodFn is invoked. So by the time
      // the AI Guard handler observes the event, the LLM call has already been made.
      const observed = { llmCalledBeforeGuard: false }
      const unsubscribe = subscribeWithHandler(ctx => {
        observed.llmCalledBeforeGuard = llmCalled
        ctx.resolve()
      })

      let llmCalled = false
      class TimingCompletions {
        create () {
          llmCalled = true
          return new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })
        }
      }
      TimingCompletions.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/chat/completions', 'Completions', TimingCompletions)

      return new TimingCompletions().create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => assert.strictEqual(observed.llmCalledBeforeGuard, true))
        .finally(unsubscribe)
    })

    it('skips AI Guard for streaming chat.completions', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })
  })

  describe('chat.completions structured outputs (_thenUnwrap)', () => {
    let Completions

    beforeEach(() => {
      Completions = class extends FakeChatCompletions {}
      Completions.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/chat/completions', 'Completions', Completions)
    })

    function schemaCallback (body) {
      return { ...body, parsed: { ok: true } }
    }

    it('runs Before Model and After Model when awaiting the unwrapped promise', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const assistant = { role: 'assistant', content: '{"ok":true}' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeUnwrappableAPIPromise({ choices: [{ message: assistant }] })

      const apiProm = completions.create({ messages: [{ role: 'user', content: 'Hi' }] })
      return apiProm._thenUnwrap(schemaCallback).parse()
        .then(body => {
          assert.strictEqual(body.parsed.ok, true)
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].messages[1], { role: 'assistant', content: '{"ok":true}' })
        })
        .finally(unsubscribe)
    })

    it('rejects with AI Guard error when Before Model denies on the unwrapped promise', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => ctx.reject(err))
      const completions = new Completions()
      const body = { choices: [{ message: { role: 'assistant', content: 'x' } }] }
      completions._nextApiPromise = new FakeUnwrappableAPIPromise(body)

      const apiProm = completions.create({ messages: [{ role: 'user', content: 'Hi' }] })
      return assert.rejects(
        () => apiProm._thenUnwrap(schemaCallback).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('rejects with AI Guard error when After Model denies on the unwrapped promise', () => {
      let count = 0
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => {
        count++
        count === 1 ? ctx.resolve() : ctx.reject(err)
      })
      const completions = new Completions()
      const body = { choices: [{ message: { role: 'assistant', content: 'leaked pii' } }] }
      completions._nextApiPromise = new FakeUnwrappableAPIPromise(body)

      const apiProm = completions.create({ messages: [{ role: 'user', content: 'Hi' }] })
      return assert.rejects(
        () => apiProm._thenUnwrap(schemaCallback).parse(),
        e => e === err
      ).finally(unsubscribe)
    })
  })

  describe('responses.create', () => {
    let Responses

    beforeEach(() => {
      Responses = class extends FakeResponses {}
      Responses.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/responses/responses', 'Responses', Responses)
    })

    it('converts string input to a single user message', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({ input: 'what time is it?' }).parse()
        .then(() => assert.deepStrictEqual(calls[0].messages, [{ role: 'user', content: 'what time is it?' }]))
        .finally(unsubscribe)
    })

    it('publishes After Model using response.output message items', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello!' }],
        }],
      })

      return responses.create({ input: 'hi' }).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].messages[1], { role: 'assistant', content: 'Hello!' })
        })
        .finally(unsubscribe)
    })

    it('publishes After Model using response.output function_call items', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({
        output: [{ type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"x"}' }],
      })

      return responses.create({ input: 'hi' }).parse()
        .then(() => assert.deepStrictEqual(calls[1].messages[1].tool_calls, [
          { id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } },
        ]))
        .finally(unsubscribe)
    })

    it('skips AI Guard for streaming requests', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({ input: 'hi', stream: true }).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })

    it('calls original directly when input is missing', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({}).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })

    it('rejects with AI Guard error when Before Model denies', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => ctx.reject(err))
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }],
      })

      return assert.rejects(
        () => responses.create({ input: 'hi' }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('rejects with AI Guard error when After Model denies', () => {
      let count = 0
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => {
        count++
        count === 1 ? ctx.resolve() : ctx.reject(err)
      })
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'leaked' }] }],
      })

      return assert.rejects(
        () => responses.create({ input: 'hi' }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('skips After Model when response has no output items', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({ input: 'hi' }).parse()
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })
  })
})
