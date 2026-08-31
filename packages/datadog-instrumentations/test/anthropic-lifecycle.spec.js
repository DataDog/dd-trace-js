'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { channel, tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
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

function jsonResponse (body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function createAnthropicRequest () {
  return {
    model: 'claude-opus-4-1-20250805',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Hi' }],
  }
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

  it('reports the input denial even when the request rejects first', async () => {
    const denial = lifecycleAbortError()
    const verdictSettled = createDeferred()
    // Deny the input, but let the verdict settle only after the SDK request has already rejected.
    const unsubscribe = subscribeWithHandler([messagesBeforeChannel], ctx => {
      ctx.abortController.abort(denial)
      ctx.pending.push(verdictSettled.promise)
    })
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    apiPromise.parse = () => Promise.reject(new Error('provider exploded'))
    messages._nextApiPromise = apiPromise

    try {
      const consumed = messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
      await new Promise(resolve => setImmediate(resolve)) // let the provider rejection settle first
      verdictSettled.resolve()

      // The block wins: the caller sees AIGuardAbortError, not the provider error.
      await assert.rejects(consumed, e => e === denial)
    } finally {
      unsubscribe()
    }
  })

  it('evaluates the input when the APIPromise is consumed', async () => {
    const { calls, unsubscribe } = subscribeAutoResolve([messagesBeforeChannel])
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
    try {
      const apiPromise = messages.create(...args)

      assert.strictEqual(calls.length, 0)
      await apiPromise.parse()
      assert.strictEqual(calls.length, 1)
      assert.deepStrictEqual(calls[0].args, args)
    } finally {
      unsubscribe()
    }
  })

  it('records the request snapshot on the tracing context, not a later caller mutation', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    let asyncEndCtx
    const apmHandlers = { start () {}, asyncEnd (ctx) { asyncEndCtx = ctx } }
    apmChannel.subscribe(apmHandlers)
    const { unsubscribe } = subscribeAutoResolve([messagesBeforeChannel, messagesAfterChannel])

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const options = { messages: [{ role: 'user', content: 'original' }] }

    try {
      const apiPromise = messages.create(options)
      options.messages[0].content = 'mutated'
      await apiPromise.parse()

      // LLMObs/APM tag ctx.options; it must hold the create-time snapshot, matching what was sent.
      assert.strictEqual(asyncEndCtx.options.messages[0].content, 'original')
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
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

  it('does not wrap raw response readers for streaming messages', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    messages._nextApiPromise = apiPromise
    const originalJson = apiPromise._rawResponse.json

    try {
      const response = await messages.create({
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }).asResponse()

      assert.strictEqual(response.json, originalJson)
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

  it('evaluates raw response access and retains the parsed result', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {} }
    let asyncEndCount = 0
    let asyncEndCtx
    apmHandlers.asyncEnd = ctx => {
      asyncEndCount++
      asyncEndCtx = ctx
    }
    apmChannel.subscribe(apmHandlers)

    const { unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const body = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)
    const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

    try {
      const response = await apiPromise.asResponse()
      assert.deepStrictEqual(await response.json(), body)
      assert.strictEqual(asyncEndCount, 1)
      assert.deepStrictEqual(asyncEndCtx.result, body)

      assert.strictEqual(await apiPromise.parse(), body)
      assert.strictEqual(asyncEndCount, 1)
      assert.deepStrictEqual(asyncEndCtx.result, body)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('preserves the raw Response and evaluates its json() reader', async () => {
    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    messages._nextApiPromise = apiPromise

    try {
      const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

      assert.strictEqual(response, apiPromise._rawResponse)
      assert.strictEqual(calls.length, 0)
      assert.strictEqual(response.bodyUsed, false)
      assert.deepStrictEqual(await response.json(), body)
      assert.strictEqual(calls.length, 1)
      assert.deepStrictEqual(calls[0].body, body)
    } finally {
      unsubscribe()
    }
  })

  it('returns raw text while evaluating its decoded body', async () => {
    const { calls, unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    try {
      const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

      assert.strictEqual(await response.text(), JSON.stringify(body))
      assert.strictEqual(calls.length, 1)
      assert.deepStrictEqual(calls[0].body, body)
    } finally {
      unsubscribe()
    }
  })

  it('blocks output read through raw Response json()', async () => {
    const error = lifecycleAbortError()
    const unsubscribe = subscribeWithHandler([messagesAfterChannel], ctx => blockLifecycle(ctx, error))
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({
      role: 'assistant',
      content: [{ type: 'text', text: 'blocked' }],
    })

    try {
      const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()
      await assert.rejects(response.json(), error)
    } finally {
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

  it('handles repeated raw response rejections without an abandoned promise', async () => {
    await execFileAsync(process.execPath, [
      '--unhandled-rejections=strict',
      lifecycleRejectionFixture,
      'handled-repeated-raw-error',
    ])
  })

  it('keeps raw response access independent of a pending parser', async () => {
    const parseDeferred = createDeferred()
    const { unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise(body)
    apiPromise.parse = () => parseDeferred.promise
    messages._nextApiPromise = apiPromise

    const instrumentedPromise = messages.create({
      messages: [{ role: 'user', content: 'Hi' }],
    })
    const parsePromise = instrumentedPromise.parse()

    try {
      assert.strictEqual(await instrumentedPromise.asResponse(), apiPromise._rawResponse)

      parseDeferred.resolve(body)
      await parsePromise
    } finally {
      unsubscribe()
    }
  })

  it('does not wrap raw readers after the output subscriber leaves', async () => {
    const { unsubscribe } = subscribeAutoResolve([messagesAfterChannel])
    const messages = new Messages()
    const apiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    messages._nextApiPromise = apiPromise
    const instrumentedPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
    const originalJson = apiPromise._rawResponse.json
    unsubscribe()

    const response = await instrumentedPromise.asResponse()

    assert.strictEqual(response, apiPromise._rawResponse)
    assert.strictEqual(response.json, originalJson)
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

withVersions('anthropic', '@anthropic-ai/sdk', '>=0.33.0', version => {
  // The real SDK is required because parse() and asResponse() consume the same Response body.
  describe('anthropic real SDK reader path', () => {
    let Anthropic

    before(() => {
      const hookCallbacks = loadAnthropicInstrumentation()
      Anthropic = require(`../../../versions/@anthropic-ai/sdk@${version}`).get().Anthropic
      const probe = new Anthropic({ apiKey: 'test' })
      applyShim(hookCallbacks, 'resources/messages/messages', probe.messages.constructor)
    })

    function clientReturning (response) {
      return new Anthropic({ apiKey: 'test', fetch: () => Promise.resolve(response) })
    }

    it('evaluates the request snapshot sent before caller mutation', async () => {
      const fetchStarted = createDeferred()
      const { calls, unsubscribe } = subscribeAutoResolve([messagesBeforeChannel, messagesAfterChannel])
      let sentBody
      const client = new Anthropic({
        apiKey: 'test',
        fetch: (url, init) => {
          sentBody = JSON.parse(init.body)
          fetchStarted.resolve()
          return Promise.resolve(jsonResponse({
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
          }))
        },
      })
      const options = createAnthropicRequest()
      options.messages[0].content = 'original'
      const apiPromise = client.messages.create(options)

      try {
        await fetchStarted.promise
        options.messages[0].content = 'mutated'
        await apiPromise.parse()

        assert.strictEqual(sentBody.messages[0].content, 'original')
        assert.strictEqual(calls.length, 2)
        assert.strictEqual(calls[0].args[0].messages[0].content, 'original')
        assert.strictEqual(calls[1].args[0].messages[0].content, 'original')
      } finally {
        unsubscribe()
      }
    })

    it('keeps AI Guard active via a JSON snapshot when structuredClone fails', async () => {
      const { calls, unsubscribe } = subscribeAutoResolve([messagesBeforeChannel, messagesAfterChannel])
      let sentBody
      const client = new Anthropic({
        apiKey: 'test',
        fetch: (url, init) => {
          sentBody = JSON.parse(init.body)
          return Promise.resolve(jsonResponse({
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
          }))
        },
      })
      const options = createAnthropicRequest()
      options.messages[0].content = 'original'
      options.messages[0].nonCloneable = () => {} // structuredClone throws; the SDK's JSON drops it
      const apiPromise = client.messages.create(options)
      options.messages[0].content = 'mutated'

      try {
        await apiPromise.parse()

        // structuredClone failed, but the JSON fallback keeps the guard active on the sent prompt.
        assert.strictEqual(calls.length, 2)
        assert.strictEqual(calls[0].args[0].messages[0].content, 'original')
        assert.strictEqual(calls[1].args[0].messages[0].content, 'original')
        assert.strictEqual(sentBody.messages[0].content, 'original')
        assert.strictEqual(Object.hasOwn(sentBody.messages[0], 'nonCloneable'), false)
      } finally {
        unsubscribe()
      }
    })

    it('preserves the SDK response and evaluates its json() reader', async () => {
      const afterCalls = []
      const onAfter = ctx => { afterCalls.push(ctx); ctx.pending.push(Promise.resolve()) }
      messagesAfterChannel.subscribe(onAfter)

      let asyncEndCtx
      const apmChannel = tracingChannel('apm:anthropic:request')
      const apmHandlers = { start () {}, asyncEnd (ctx) { asyncEndCtx = ctx } }
      apmChannel.subscribe(apmHandlers)

      const body = { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      const rawResponse = jsonResponse(body)
      const apiPromise = clientReturning(rawResponse).messages.create(createAnthropicRequest())

      try {
        const response = await apiPromise.asResponse()
        assert.strictEqual(response, rawResponse)
        assert.strictEqual(afterCalls.length, 0)
        assert.strictEqual(response.bodyUsed, false)
        assert.deepStrictEqual(await response.json(), body)
        assert.strictEqual(afterCalls.length, 1)
        assert.deepStrictEqual(afterCalls[0].body.content, body.content)
        assert.deepStrictEqual(asyncEndCtx.result.content, body.content)
      } finally {
        apmChannel.unsubscribe(apmHandlers)
        messagesAfterChannel.unsubscribe(onAfter)
      }
    })

    it('blocks the real SDK response json() reader', async () => {
      const error = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const onAfter = ctx => { ctx.abortController.abort(error); ctx.pending.push(Promise.resolve()) }
      messagesAfterChannel.subscribe(onAfter)

      const body = { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      const apiPromise = clientReturning(jsonResponse(body)).messages.create(createAnthropicRequest())

      try {
        const response = await apiPromise.asResponse()
        await assert.rejects(response.json(), { name: 'AIGuardAbortError', message: 'blocked' })
      } finally {
        messagesAfterChannel.unsubscribe(onAfter)
      }
    })

    it('blocks output read through a cloned real SDK response', async () => {
      const error = lifecycleAbortError()
      const onAfter = ctx => blockLifecycle(ctx, error)
      messagesAfterChannel.subscribe(onAfter)

      const body = { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      const apiPromise = clientReturning(jsonResponse(body)).messages.create(createAnthropicRequest())

      try {
        const response = await apiPromise.asResponse()
        await assert.rejects(response.clone().json(), error)
      } finally {
        messagesAfterChannel.unsubscribe(onAfter)
      }
    })

    it('fails open for a malformed raw response and preserves custom state', async () => {
      const afterCalls = []
      const onAfter = ctx => { afterCalls.push(ctx); ctx.pending.push(Promise.resolve()) }
      messagesAfterChannel.subscribe(onAfter)

      const rawResponse = new Response('not JSON', {
        headers: { 'content-type': 'application/json' },
      })
      rawResponse.customState = { endpoint: 'custom' }

      try {
        const response = await clientReturning(rawResponse).messages.create(createAnthropicRequest()).asResponse()

        assert.strictEqual(response, rawResponse)
        assert.deepStrictEqual(response.customState, { endpoint: 'custom' })
        assert.strictEqual(await response.text(), 'not JSON')
        assert.strictEqual(afterCalls.length, 0)
      } finally {
        messagesAfterChannel.unsubscribe(onAfter)
      }
    })

    it('evaluates a large node-fetch response without cloning its stream', async function () {
      let NodeFetchResponse
      try {
        NodeFetchResponse = require(`../../../versions/@anthropic-ai/sdk@${version}`).get('node-fetch').Response
      } catch {
        this.skip()
        return
      }
      const body = {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(64 * 1024) }],
      }
      const rawResponse = new NodeFetchResponse(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        counter: 1,
        status: 200,
        url: 'https://api.anthropic.com/v1/messages',
      })
      const onAfter = ctx => { ctx.pending.push(Promise.resolve()) }
      messagesAfterChannel.subscribe(onAfter)

      try {
        const response = await clientReturning(rawResponse).messages.create(createAnthropicRequest()).asResponse()

        assert.strictEqual(response, rawResponse)
        assert.strictEqual(response.url, 'https://api.anthropic.com/v1/messages')
        assert.strictEqual(response.redirected, true)
        assert.deepStrictEqual(await response.json(), body)
      } finally {
        messagesAfterChannel.unsubscribe(onAfter)
      }
    })
  })
})
