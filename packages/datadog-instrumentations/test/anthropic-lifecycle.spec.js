'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { channel, tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const {
  FakeAPIPromise,
  FakeMessages,
  applyShim,
  createDeferred,
  loadAnthropicInstrumentation,
} = require('./helpers/anthropic-lifecycle')

const messagesBeforeChannel = channel('dd-trace:anthropic:messages:before')
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')
const execFileAsync = promisify(execFile)
const lifecycleRejectionFixture = path.join(__dirname, 'fixtures', 'anthropic-lifecycle-rejections.js')

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

  it('wraps streaming responses when tracing is active', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    apmChannel.subscribe(apmHandlers)

    const stream = {
      [Symbol.asyncIterator] () {
        return {
          next: () => Promise.resolve({ done: true }),
        }
      },
    }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(stream)

    try {
      assert.strictEqual(
        await messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse(),
        stream
      )
    } finally {
      apmChannel.unsubscribe(apmHandlers)
    }
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

  it('reuses the before verdict after its subscriber leaves', async () => {
    const error = lifecycleAbortError()
    const unsubscribe = subscribeWithHandler(
      [messagesBeforeChannel],
      /**
       * @param {{ abortController: AbortController, pending: Promise<void>[] }} ctx
       */
      ctx => {
        blockLifecycle(ctx, error)
        unsubscribe()
      }
    )
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      await Promise.all([
        assert.rejects(apiPromise.parse(), { name: error.name, message: error.message }),
        assert.rejects(apiPromise.asResponse(), { name: error.name, message: error.message }),
      ])
    } finally {
      unsubscribe()
    }
  })

  it('finishes after a resolving before subscriber leaves', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const unsubscribe = subscribeWithHandler(
      [messagesBeforeChannel],
      /**
       * @param {{ pending: Promise<void>[] }} ctx
       */
      ctx => {
        ctx.pending.push(Promise.resolve())
        unsubscribe()
      }
    )
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    messages._nextApiPromise = apiPromise

    try {
      assert.strictEqual(
        await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
        apiPromise._rawResponse
      )
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('evaluates and finishes an unconsumed raw response without consuming it', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCtx
    apmHandlers.asyncEnd = ctx => { asyncEndCtx = ctx }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    try {
      const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

      assert.strictEqual(calls.length, 2)
      assert.strictEqual(calls[1].body, JSON.stringify(body))
      assert.ok(asyncEndCtx, 'asyncEnd was not published')
      assert.strictEqual(asyncEndCtx.finished, true)
      assert.strictEqual(response.bodyUsed, false)
      assert.deepStrictEqual(await response.json(), body)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('evaluates repeated asResponse() calls once', async () => {
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      const firstPromise = apiPromise.asResponse()
      const secondPromise = apiPromise.asResponse()

      assert.notStrictEqual(firstPromise, secondPromise)

      const [firstResponse, secondResponse] = await Promise.all([firstPromise, secondPromise])

      assert.strictEqual(firstResponse, secondResponse)
      assert.strictEqual(calls.length, 2)
    } finally {
      unsubscribe()
    }
  })

  it('finishes a raw Node stream response without cloning it', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const messages = new Messages()
    const body = { role: 'assistant', content: [] }
    const apiPromise = new FakeAPIPromise(body)
    const readJson = sinon.stub().resolves(body)
    const response = {
      body: { pipe: sinon.spy() },
      clone: sinon.spy(),
      json: readJson,
    }
    apiPromise._rawResponse = response
    messages._nextApiPromise = apiPromise

    try {
      assert.strictEqual(
        await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
        response
      )
      sinon.assert.notCalled(response.clone)
      assert.strictEqual(calls.length, 0)
      assert.strictEqual(asyncEndCount, 1)
      assert.deepStrictEqual(await response.json(), body)
      sinon.assert.calledOnce(readJson)
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].body, body)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('blocks deferred raw Node stream body consumption', async () => {
    const error = lifecycleAbortError()
    let calls = 0
    const unsubscribe = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ abortController: AbortController, pending: Promise<void>[] }} ctx
       */
      ctx => {
        calls++
        blockLifecycle(ctx, error)
      }
    )
    const body = { role: 'assistant', content: [] }
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    const response = {
      body: { pipe: sinon.spy() },
      clone: sinon.spy(),
      text: sinon.stub().resolves(JSON.stringify(body)),
    }
    apiPromise._rawResponse = response
    messages._nextApiPromise = apiPromise

    try {
      assert.strictEqual(
        await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
        response
      )
      await assert.rejects(response.text(), error)
      assert.strictEqual(calls, 1)
    } finally {
      unsubscribe()
    }
  })

  it('allows deferred raw Node stream consumption after its subscriber leaves', async () => {
    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const body = { role: 'assistant', content: [] }
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    const response = {
      body: { pipe: sinon.spy() },
      json: sinon.stub().resolves(body),
    }
    apiPromise._rawResponse = response
    messages._nextApiPromise = apiPromise

    const returnedResponse = await messages.create({
      messages: [{ role: 'user', content: 'Hi' }],
    }).asResponse()
    unsubscribe()

    assert.strictEqual(returnedResponse, response)
    assert.deepStrictEqual(await response.json(), body)
    assert.strictEqual(calls.length, 0)
  })

  it('does not clone a consumed response owned by the parser', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const parseDeferred = createDeferred()
    const body = { role: 'assistant', content: [] }
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    const response = {
      bodyUsed: true,
      clone: sinon.spy(),
    }
    apiPromise.parse = () => parseDeferred.promise
    apiPromise._rawResponse = response
    messages._nextApiPromise = apiPromise
    const instrumentedPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
    const parsePromise = instrumentedPromise.parse()

    try {
      assert.strictEqual(await instrumentedPromise.asResponse(), response)
      sinon.assert.notCalled(response.clone)

      parseDeferred.resolve(body)
      await parsePromise
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('finishes without a tracing error when cloning or reading the raw response throws', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let errorCount = 0
    let asyncEndCount = 0
    apmHandlers.error = () => { errorCount++ }
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const error = new Error('clone failed')
    const cloneFailures = [
      () => { throw error },
      () => ({ text: () => { throw error } }),
    ]

    try {
      for (const clone of cloneFailures) {
        const messages = new Messages()
        const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
        apiPromise._rawResponse.clone = clone
        messages._nextApiPromise = apiPromise

        const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

        assert.strictEqual(response, apiPromise._rawResponse)
      }
      assert.strictEqual(errorCount, 0)
      assert.strictEqual(asyncEndCount, cloneFailures.length)
      assert.strictEqual(calls.length, 0)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('fails open for arbitrary raw response read rejections without logging their values', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let errorCount = 0
    let asyncEndCount = 0
    apmHandlers.error = () => { errorCount++ }
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const logError = sinon.stub(log, 'error')
    const throwingMessage = {}
    Object.defineProperty(throwingMessage, 'message', {
      get () {
        throw new Error('message getter should not run')
      },
    })
    const rejections = [new Error('body failed'), undefined, null, 'sensitive response body', throwingMessage]

    try {
      for (const rejection of rejections) {
        const messages = new Messages()
        const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
        apiPromise._rawResponse.clone = () => ({ text: () => Promise.reject(rejection) })
        messages._nextApiPromise = apiPromise

        const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

        assert.strictEqual(response, apiPromise._rawResponse)
      }
      assert.strictEqual(errorCount, 0)
      assert.strictEqual(asyncEndCount, rejections.length)
      assert.strictEqual(calls.length, 0)
      assert.strictEqual(logError.callCount, rejections.length)
      for (const call of logError.getCalls()) {
        assert.deepStrictEqual(call.args, ['Unable to read Anthropic response body'])
      }
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
      logError.restore()
    }
  })

  it('lets a started parser own the span when the raw response read fails', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let errorCount = 0
    let asyncEndCount = 0
    apmHandlers.error = () => { errorCount++ }
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const settlementOrders = ['raw-first', 'parse-first']

    try {
      for (const settlementOrder of settlementOrders) {
        const cloneStarted = createDeferred()
        const cloneDeferred = createDeferred()
        const parseDeferred = createDeferred()
        const messages = new Messages()
        const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
        const parseError = new SyntaxError('invalid response')
        apiPromise.parse = () => parseDeferred.promise
        apiPromise._rawResponse.clone = () => ({
          text: () => {
            cloneStarted.resolve()
            return cloneDeferred.promise
          },
        })
        messages._nextApiPromise = apiPromise
        const instrumentedPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
        const responsePromise = instrumentedPromise.asResponse()

        await cloneStarted.promise

        const parsePromise = instrumentedPromise.parse()
        const parseRejection = assert.rejects(parsePromise, parseError)

        if (settlementOrder === 'raw-first') {
          cloneDeferred.reject(new Error('clone failed'))
          await responsePromise
          parseDeferred.reject(parseError)
        } else {
          parseDeferred.reject(parseError)
          await parseRejection
          cloneDeferred.reject(new Error('clone failed'))
        }

        await Promise.all([responsePromise, parseRejection])
      }

      assert.strictEqual(errorCount, settlementOrders.length)
      assert.strictEqual(asyncEndCount, settlementOrders.length)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('honors an after verdict published while the raw response read is pending', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let errorCount = 0
    let asyncEndCount = 0
    apmHandlers.error = () => { errorCount++ }
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const error = lifecycleAbortError()
    const afterPublished = createDeferred()
    const unsubscribe = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ abortController: AbortController, pending: Promise<void>[] }} ctx
       */
      ctx => {
        blockLifecycle(ctx, error)
        afterPublished.resolve()
      }
    )
    const cloneStarted = createDeferred()
    const cloneDeferred = createDeferred()
    const parseDeferred = createDeferred()
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    apiPromise.parse = () => parseDeferred.promise
    apiPromise._rawResponse.clone = () => ({
      text: () => {
        cloneStarted.resolve()
        return cloneDeferred.promise
      },
    })
    messages._nextApiPromise = apiPromise
    const instrumentedPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
    const responsePromise = instrumentedPromise.asResponse()

    try {
      await cloneStarted.promise

      const parsePromise = instrumentedPromise.parse()
      const parseRejection = assert.rejects(parsePromise, error)
      parseDeferred.resolve(apiPromise._body)
      await afterPublished.promise
      cloneDeferred.reject(new Error('clone failed'))

      await Promise.all([
        parseRejection,
        assert.rejects(responsePromise, error),
      ])
      assert.strictEqual(errorCount, 1)
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('honors a resolving after verdict when the raw response read fails', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const afterPublished = createDeferred()
    const unsubscribe = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ pending: Promise<void>[] }} ctx
       */
      ctx => {
        ctx.pending.push(Promise.resolve())
        afterPublished.resolve()
      }
    )
    const cloneStarted = createDeferred()
    const cloneDeferred = createDeferred()
    const parseDeferred = createDeferred()
    const body = { role: 'assistant', content: [] }
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    apiPromise.parse = () => parseDeferred.promise
    apiPromise._rawResponse.clone = () => ({
      text: () => {
        cloneStarted.resolve()
        return cloneDeferred.promise
      },
    })
    messages._nextApiPromise = apiPromise
    const instrumentedPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
    const responsePromise = instrumentedPromise.asResponse()

    try {
      await cloneStarted.promise

      const parsePromise = instrumentedPromise.parse()
      parseDeferred.resolve(body)
      await afterPublished.promise
      cloneDeferred.reject(new Error('clone failed'))

      const [parsed, response] = await Promise.all([parsePromise, responsePromise])

      assert.strictEqual(parsed, body)
      assert.strictEqual(response, apiPromise._rawResponse)
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('finishes when the after subscriber leaves while the clone is read', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const body = { role: 'assistant', content: [] }
    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    apiPromise._rawResponse.clone = () => ({
      text: async () => {
        unsubscribe()
        return JSON.stringify(body)
      },
    })
    messages._nextApiPromise = apiPromise

    try {
      const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

      assert.strictEqual(response, apiPromise._rawResponse)
      assert.strictEqual(asyncEndCount, 1)
      assert.strictEqual(calls.length, 0)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('evaluates and finishes exactly once when asResponse() starts before parse()', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      await Promise.all([apiPromise.asResponse(), apiPromise.parse()])

      assert.strictEqual(calls.length, 2)
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('keeps a raw-terminal span finished when parsing starts later', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      await apiPromise.asResponse()
      await apiPromise.parse()
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('evaluates and finishes when the caller uses withResponse()', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCtx
    apmHandlers.asyncEnd = ctx => { asyncEndCtx = ctx }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    try {
      const { data, response } = await messages.create({
        messages: [{ role: 'user', content: 'Hello' }],
      }).withResponse()

      assert.strictEqual(data, body)
      assert.ok(response.ok)
      assert.strictEqual(calls.length, 2)
      assert.ok(asyncEndCtx, 'asyncEnd was not published')
      assert.strictEqual(asyncEndCtx.finished, true)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
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

  it('propagates after lifecycle rejection through withResponse()', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let afterCalls = 0
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const error = lifecycleAbortError()
    const { unsubscribe: unsubscribeBefore } = subscribeAutoResolve([messagesBeforeChannel])
    const unsubscribeAfter = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ abortController: AbortController, pending: Promise<void>[] }} ctx
       */
      ctx => {
        afterCalls++
        blockLifecycle(ctx, error)
      }
    )
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    try {
      await assert.rejects(
        messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).withResponse(),
        error
      )
      assert.strictEqual(afterCalls, 1)
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribeBefore()
      unsubscribeAfter()
    }
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

  it('leaves the evaluated raw response available through response.json()', async () => {
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
    try {
      const response = await messages.create(...args).asResponse()

      assert.deepStrictEqual(await response.json(), body)
      assert.strictEqual(calls.length, 2)
      assert.strictEqual(calls[1].body, JSON.stringify(body))
    } finally {
      unsubscribe()
    }
  })

  it('leaves the evaluated raw response available through response.text()', async () => {
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }
    const { calls, unsubscribe } = subscribeAutoResolve([
      messagesBeforeChannel,
      messagesAfterChannel,
    ])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    try {
      const response = await messages.create([{ messages: [{ role: 'user', content: 'Hi' }] }]).asResponse()
      const raw = await response.text()

      assert.strictEqual(raw, JSON.stringify(body))
      assert.strictEqual(calls.length, 2)
      assert.strictEqual(calls[1].body, JSON.stringify(body))
    } finally {
      unsubscribe()
    }
  })

  it('rejects asResponse() when the after lifecycle denies', async () => {
    const err = lifecycleAbortError()
    const unsubscribeAfter = subscribeWithHandler([messagesAfterChannel], ctx => blockLifecycle(ctx, err))
    const unsubscribeBefore = subscribeWithHandler([messagesBeforeChannel], ctx => {
      ctx.pending.push(Promise.resolve())
    })
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    try {
      await assert.rejects(
        () => messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
        /** @param {Error} error */
        error => error === err
      )
    } finally {
      unsubscribeAfter()
      unsubscribeBefore()
    }
  })

  it('reuses the after verdict after its subscriber leaves', async () => {
    const error = lifecycleAbortError()
    let calls = 0
    const unsubscribe = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ abortController: AbortController, pending: Promise<void>[] }} ctx
       */
      ctx => {
        calls++
        blockLifecycle(ctx, error)
        unsubscribe()
      }
    )
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      await assert.rejects(apiPromise.asResponse(), { name: error.name, message: error.message })
      await assert.rejects(apiPromise.parse(), { name: error.name, message: error.message })
      assert.strictEqual(calls, 1)
    } finally {
      unsubscribe()
    }
  })

  it('reuses the after verdict when parse() starts before asResponse()', async () => {
    const error = lifecycleAbortError()
    let calls = 0
    const unsubscribe = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ abortController: AbortController, pending: Promise<void>[] }} ctx
       */
      ctx => {
        calls++
        blockLifecycle(ctx, error)
        unsubscribe()
      }
    )
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
    const expectedError = { name: error.name, message: error.message }

    try {
      const parseRejection = assert.rejects(apiPromise.parse(), expectedError)
      await Promise.resolve()
      assert.strictEqual(calls, 1)

      await Promise.all([
        parseRejection,
        assert.rejects(apiPromise.asResponse(), expectedError),
      ])
    } finally {
      unsubscribe()
    }
  })

  it('waits for a cached after verdict after its subscriber leaves', async () => {
    const afterPublished = createDeferred()
    const afterPending = createDeferred()
    let calls = 0
    const unsubscribe = subscribeWithHandler(
      [messagesAfterChannel],
      /**
       * @param {{ pending: Promise<void>[] }} ctx
       */
      ctx => {
        calls++
        ctx.pending.push(afterPending.promise)
        unsubscribe()
        afterPublished.resolve()
      }
    )
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
    const parsePromise = apiPromise.parse()

    try {
      await afterPublished.promise
      const responsePromise = apiPromise.asResponse()
      afterPending.resolve()

      const [, response] = await Promise.all([parsePromise, responsePromise])

      assert.strictEqual(response, messages._nextApiPromise._rawResponse)
      assert.strictEqual(calls, 1)
    } finally {
      unsubscribe()
    }
  })

  it('does not emit a duplicate unhandled rejection when a parse lifecycle block is caught', async () => {
    await execFileAsync(process.execPath, [
      '--unhandled-rejections=strict',
      lifecycleRejectionFixture,
      'caught-after-verdict',
    ])
  })

  it('preserves an unhandled parse rejection when its result is ignored', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--unhandled-rejections=strict',
        lifecycleRejectionFixture,
        'ignored-parse-error',
      ]),
      { code: 1, stderr: /SyntaxError: invalid response/ }
    )
  })

  it('preserves an unhandled parse rejection when raw response access is handled', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--unhandled-rejections=strict',
        lifecycleRejectionFixture,
        'ignored-parse-error-with-raw',
      ]),
      { code: 1, stderr: /SyntaxError: invalid response/ }
    )
  })

  it('preserves an ignored raw lifecycle rejection across repeated calls', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        '--unhandled-rejections=strict',
        lifecycleRejectionFixture,
        'ignored-first-raw',
      ]),
      { code: 1, stderr: /Error: blocked/ }
    )
  })

  it('does not wait for a pending parser before returning an evaluated raw response', async () => {
    await execFileAsync(process.execPath, [
      '--unhandled-rejections=strict',
      lifecycleRejectionFixture,
      'raw-with-pending-parse',
    ])
  })

  it('evaluates the raw response independently when parse() rejects before the after lifecycle', async () => {
    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const error = new SyntaxError('invalid response')
    apiPromise.parse = () => Promise.reject(error)
    messages._nextApiPromise = apiPromise
    const instrumentedPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      const [, response] = await Promise.all([
        assert.rejects(instrumentedPromise.parse(), error),
        instrumentedPromise.asResponse(),
      ])

      assert.strictEqual(response, apiPromise._rawResponse)
      assert.strictEqual(calls.length, 1)
    } finally {
      unsubscribe()
    }
  })

  it('evaluates and finishes exactly once when parse() starts before asResponse()', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    apmHandlers.asyncEnd = () => { asyncEndCount++ }
    apmChannel.subscribe(apmHandlers)

    const { calls, unsubscribe } = subscribeAutoResolve([messagesBeforeChannel, messagesAfterChannel])

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      await Promise.all([
        apiPromise.parse(),
        apiPromise.asResponse(),
      ])

      assert.strictEqual(calls.length, 2)
      assert.strictEqual(asyncEndCount, 1)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })
})
