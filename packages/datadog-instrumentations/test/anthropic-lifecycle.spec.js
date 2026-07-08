'use strict'

const assert = require('node:assert/strict')

const { channel, tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const messagesBeforeChannel = channel('dd-trace:anthropic:messages:before')
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

class FakeAPIPromise {
  constructor (body) {
    this._body = body
    this._rawResponse = { ok: true }
  }

  parse () {
    return Promise.resolve(this._body)
  }

  asResponse () {
    return Promise.resolve(this._rawResponse)
  }

  withResponse () {
    return Promise.all([this.parse(), this.asResponse()]).then(([data, response]) => ({ data, response }))
  }

  then (onFulfilled, onRejected) {
    return this.parse().then(onFulfilled, onRejected)
  }
}

class FakeMessages {
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

function blockLifecycle (ctx, err) {
  ctx.abortController.abort(err)
  ctx.pending.push(Promise.resolve())
}

function loadAnthropicInstrumentation () {
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
    delete require.cache[require.resolve('../src/anthropic')]
    require('../src/anthropic')
  } finally {
    cache.exports = prevExports
  }

  return hookCallbacks
}

function applyShim (hookCallbacks, filePath, Messages) {
  for (const { spec, cb } of hookCallbacks) {
    if (spec.file === `${filePath}.js`) {
      cb({ Messages })
      return
    }
  }
  throw new Error(`No hook registered for ${filePath}.js`)
}

describe('anthropic lifecycle instrumentation', () => {
  let hookCallbacks
  let Messages

  before(() => {
    hookCallbacks = loadAnthropicInstrumentation()
  })

  beforeEach(() => {
    Messages = class extends FakeMessages {}
    Messages.prototype._client = { baseURL: 'https://api.anthropic.com' }
    applyShim(hookCallbacks, 'resources/messages/messages', Messages)
  })

  it('publishes before and after lifecycle payloads with native Anthropic shapes', () => {
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
    return messages.create(...args).parse()
      .then(() => {
        assert.strictEqual(calls.length, 2)
        assert.deepStrictEqual(calls[0].args, args)
        assert.deepStrictEqual(calls[1].args, args)
        assert.strictEqual(calls[1].body, body)
        assert.ok(calls[0].abortController instanceof AbortController)
        assert.ok(Array.isArray(calls[0].pending))
      })
      .finally(unsubscribe)
  })

  it('forwards the anthropic.request span on lifecycle payloads', () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const parentSpan = { fake: 'anthropic.request span' }
    const apmHandlers = {
      start (ctx) {
        ctx.currentStore = { span: parentSpan }
      },
    }
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    })

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
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
    const unsubscribe = subscribeWithHandler([messagesBeforeChannel], ctx => blockLifecycle(ctx, err))
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    })

    return assert.rejects(
      () => messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
      e => e === err
    ).finally(unsubscribe)
  })

  it('skips lifecycle channels for streaming messages', () => {
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    })

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
      .then(() => assert.strictEqual(calls.length, 0))
      .finally(unsubscribe)
  })

  it('publishes lifecycle channels when stream is explicitly false', () => {
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    })

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: false }).parse()
      .then(() => assert.strictEqual(calls.length, 2))
      .finally(unsubscribe)
  })

  it('propagates before lifecycle rejection through asResponse()', () => {
    const err = lifecycleAbortError()
    const unsubscribe = subscribeWithHandler([messagesBeforeChannel], ctx => blockLifecycle(ctx, err))
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    })

    return assert.rejects(
      () => messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
      e => e === err
    ).finally(unsubscribe)
  })

  it('publishes asyncEnd when the caller uses asResponse() without parse()', () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCtx
    apmHandlers.asyncEnd = ctx => { asyncEndCtx = ctx }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()
      .then(() => {
        assert.ok(asyncEndCtx, 'asyncEnd was not published')
        assert.strictEqual(asyncEndCtx.finished, true)
      })
      .finally(() => apmChannel.unsubscribe(apmHandlers))
  })

  it('publishes asyncEnd exactly once when both asResponse() and parse() are called', () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    return Promise.all([apiPromise.asResponse(), apiPromise.parse()])
      .then(() => assert.strictEqual(asyncEndCount, 1))
      .finally(() => apmChannel.unsubscribe(apmHandlers))
  })

  it('publishes asyncEnd when the caller uses withResponse() without parse()', () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCtx
    apmHandlers.asyncEnd = ctx => { asyncEndCtx = ctx }
    apmChannel.subscribe(apmHandlers)

    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    return messages.create({ messages: [{ role: 'user', content: 'Hello' }] }).withResponse()
      .then(({ data, response }) => {
        assert.strictEqual(data, body)
        assert.ok(response.ok)
        assert.ok(asyncEndCtx, 'asyncEnd was not published')
        assert.strictEqual(asyncEndCtx.finished, true)
      })
      .finally(() => apmChannel.unsubscribe(apmHandlers))
  })

  it('propagates before lifecycle rejection through withResponse()', () => {
    const err = lifecycleAbortError()
    const unsubscribe = subscribeWithHandler([messagesBeforeChannel], ctx => blockLifecycle(ctx, err))
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    return assert.rejects(
      () => messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).withResponse(),
      e => e === err
    ).finally(unsubscribe)
  })

  it('publishes asyncEnd exactly once when withResponse() and parse() are both called', () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    return Promise.all([apiPromise.withResponse(), apiPromise.parse()])
      .then(() => assert.strictEqual(asyncEndCount, 1))
      .finally(() => apmChannel.unsubscribe(apmHandlers))
  })

  it('publishes the before lifecycle once when the same APIPromise is consumed multiple ways', () => {
    const { calls, unsubscribe } = subscribeAutoResolve([messagesBeforeChannel])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }],
    })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    return Promise.all([
      apiPromise.asResponse(),
      apiPromise.parse(),
    ])
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })
})
