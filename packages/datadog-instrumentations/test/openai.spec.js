'use strict'

const assert = require('node:assert/strict')
const { channel, tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = channel('dd-trace:openai:responses:intercept')

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
  // The real SDK builds a new APIPromise around the *same* response promise, which is what lets
  // the prototype wrappers find the registered state. `responses.parse` relies on this.
  _thenUnwrap (cb) {
    return new FakeAPIPromise(cb(this._body), this.responsePromise)
  }
}

/**
 * Mirrors the OpenAI SDK's `Stream`: `iterator` is an own property returning a fresh async
 * iterator, and `[Symbol.asyncIterator]` delegates to it.
 */
class FakeStream {
  constructor (chunks) {
    this.iterator = () => {
      let index = 0
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined }),
      }
    }
  }

  [Symbol.asyncIterator] () {
    return this.iterator()
  }
}

function readAll (stream) {
  const received = []
  const iterator = stream[Symbol.asyncIterator]()
  function step () {
    return iterator.next().then(({ done, value }) => {
      if (done) return received
      received.push(value)
      return step()
    })
  }
  return step()
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

function subscribeIntercept (interceptChannel, onIntercept = () => {}) {
  const calls = []
  const handler = ctx => {
    calls.push(ctx)
    onIntercept(ctx)
  }
  interceptChannel.subscribe(handler)
  return { calls, unsubscribe: () => interceptChannel.unsubscribe(handler) }
}

function loadOpenAIInstrumentation () {
  const instrumentPath = require.resolve('../src/helpers/instrument')
  const realInstrument = require(instrumentPath)
  const hookCallbacks = []

  const stub = {
    ...realInstrument,
    addHook (spec, hook) {
      hookCallbacks.push({ spec, hook })
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
    delete require.cache[require.resolve('../src/openai')]
  }

  return hookCallbacks
}

function applyApiPromiseShim (hookCallbacks) {
  applyShim(hookCallbacks, 'core/api-promise', 'APIPromise', FakeAPIPromise)
}

function applyShim (hookCallbacks, filePath, targetClass, TargetClass) {
  for (const { spec, hook } of hookCallbacks) {
    if (spec.file === `${filePath}.js`) {
      hook({ [targetClass]: TargetClass })
      return
    }
  }
  throw new Error(`No hook registered for ${filePath}.js`)
}

describe('openai interception', () => {
  let hookCallbacks

  before(() => {
    hookCallbacks = loadOpenAIInstrumentation()
    applyApiPromiseShim(hookCallbacks)
  })

  describe('chat.completions.create', () => {
    let Completions

    beforeEach(() => {
      Completions = class extends FakeChatCompletions {}
      Completions.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/chat/completions', 'Completions', Completions)
    })

    it('calls original directly when nothing is subscribed', () => {
      const assistant = { role: 'assistant', content: 'Hello!' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: assistant }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(body => assert.strictEqual(body.choices[0].message, assistant))
    })

    it('finishes the span with only APM tracing active', () => {
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

    it('publishes the native call data once', () => {
      const { calls, unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel)
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
      return completions.create(...args).parse()
        .then(() => {
          assert.strictEqual(calls.length, 1)
          assert.deepStrictEqual(calls[0].arguments, args)
          assert.ok(calls[0].tracingContext)
        })
        .finally(unsubscribe)
    })

    it('lets a subscriber replace the delivered body', () => {
      const replacement = { choices: [{ message: { role: 'assistant', content: 'redacted' } }] }
      const { unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel, ctx => {
        ctx.onResult = () => replacement
      })
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(body => assert.strictEqual(body, replacement))
        .finally(unsubscribe)
    })

    it('holds raw-response callers until beforeResult settles', () => {
      const order = []
      const { unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel, ctx => {
        ctx.beforeResult = () => Promise.resolve().then(() => order.push('beforeResult'))
      })
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()
        .then(() => assert.deepStrictEqual(order, ['beforeResult']))
        .finally(unsubscribe)
    })

    it('finishes the span only after beforeResult and onResult settle', () => {
      const order = []
      const { unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel, ctx => {
        ctx.beforeResult = () => Promise.resolve().then(() => order.push('beforeResult'))
        ctx.onResult = body => Promise.resolve().then(() => {
          order.push('onResult')
          return body
        })
      })
      const apmChannel = tracingChannel('apm:openai:request')
      const apmHandlers = { start () {}, asyncEnd () { order.push('asyncEnd') } }
      apmChannel.subscribe(apmHandlers)

      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => assert.deepStrictEqual(order, ['beforeResult', 'onResult', 'asyncEnd']))
        .finally(() => {
          apmChannel.unsubscribe(apmHandlers)
          unsubscribe()
        })
    })

    it('marks the span errored when beforeResult rejects', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const { unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel, ctx => {
        ctx.beforeResult = () => Promise.reject(err)
      })
      const apmChannel = tracingChannel('apm:openai:request')
      let erroredCtx
      const apmHandlers = { start () {}, error (ctx) { erroredCtx = ctx } }
      apmChannel.subscribe(apmHandlers)

      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
        e => e === err
      )
        .then(() => assert.strictEqual(erroredCtx?.error, err))
        .finally(() => {
          apmChannel.unsubscribe(apmHandlers)
          unsubscribe()
        })
    })

    it('leaves a stream to the native call when only interception is subscribed', () => {
      const chunks = [{ choices: [{ index: 0, delta: { content: 'Hello' } }] }]
      const { calls, unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel)
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise(new FakeStream(chunks))

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
        .then(stream => readAll(stream))
        .then(received => {
          assert.deepStrictEqual(received, chunks)
          assert.deepStrictEqual(calls, [])
        })
        .finally(unsubscribe)
    })

    it('applies both callbacks on the structured-output (_thenUnwrap) path', () => {
      const order = []
      const { unsubscribe } = subscribeIntercept(chatCompletionsInterceptChannel, ctx => {
        ctx.beforeResult = () => Promise.resolve().then(() => order.push('beforeResult'))
        ctx.onResult = body => Promise.resolve().then(() => {
          order.push('onResult')
          return body
        })
      })
      const body = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }
      const completions = new Completions()
      completions._nextApiPromise = new FakeUnwrappableAPIPromise(body)

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] })
        ._thenUnwrap(result => ({ ...result, parsed: { ok: true } })).parse()
        .then(result => {
          assert.strictEqual(result.parsed.ok, true)
          assert.deepStrictEqual(order, ['beforeResult', 'onResult'])
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

    // responses.parse() calls responses.create(...)._thenUnwrap() under the hood. The unwrapped
    // APIPromise shares the response promise, so the prototype wrappers still find its state.
    it('traces and intercepts responses.parse through _thenUnwrap', () => {
      const order = []
      const { unsubscribe } = subscribeIntercept(responsesInterceptChannel, ctx => {
        ctx.beforeResult = () => Promise.resolve().then(() => order.push('beforeResult'))
        ctx.onResult = body => Promise.resolve().then(() => {
          order.push('onResult')
          return body
        })
      })
      const apmChannel = tracingChannel('apm:openai:request')
      const apmHandlers = { start () {}, asyncEnd () { order.push('asyncEnd') } }
      apmChannel.subscribe(apmHandlers)

      const body = { output: [{ type: 'message', role: 'assistant', content: 'Hi' }] }
      const responses = new Responses()
      responses._nextApiPromise = new FakeUnwrappableAPIPromise(body)

      return responses.create({ input: 'Hello' })
        ._thenUnwrap(result => ({ ...result, parsed: { ok: true } })).parse()
        .then(result => {
          assert.strictEqual(result.parsed.ok, true)
          assert.deepStrictEqual(order, ['beforeResult', 'onResult', 'asyncEnd'])
        })
        .finally(() => {
          apmChannel.unsubscribe(apmHandlers)
          unsubscribe()
        })
    })

    it('publishes the live call objects with native Responses API shapes', () => {
      const { calls, unsubscribe } = subscribeIntercept(responsesInterceptChannel)
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      const args = [{ input: 'Hello' }]
      return responses.create(...args).parse()
        .then(() => {
          assert.strictEqual(calls.length, 1)
          assert.deepStrictEqual(calls[0].arguments, args)
        })
        .finally(unsubscribe)
    })
  })
})
