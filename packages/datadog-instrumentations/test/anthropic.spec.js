'use strict'

const assert = require('node:assert/strict')

const { channel, tracingChannel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const {
  FakeAPIPromise,
  FakeMessages,
  applyShim,
  loadAnthropicInstrumentation,
} = require('./helpers/anthropic')

const messagesPrepareChannel = channel('dd-trace:anthropic:messages:prepare')
const messagesInterceptChannel = channel('dd-trace:anthropic:messages:intercept')

function subscribeIntercept (onIntercept = () => {}) {
  const calls = []
  const handler = ctx => {
    calls.push(ctx)
    onIntercept(ctx)
  }
  messagesInterceptChannel.subscribe(handler)
  return { calls, unsubscribe: () => messagesInterceptChannel.unsubscribe(handler) }
}

/**
 * Stands in for the product's call subscriber: replaces the outgoing arguments with a JSON
 * snapshot so the test can assert the instrumentation honours the replacement.
 */
function subscribeSnapshottingCall () {
  const handler = ctx => {
    const options = ctx.arguments[0]
    if (!options || typeof options !== 'object') return

    ctx.arguments[0] = { ...options, ...JSON.parse(JSON.stringify({ messages: options.messages })) }
  }
  messagesPrepareChannel.subscribe(handler)
  return { unsubscribe: () => messagesPrepareChannel.unsubscribe(handler) }
}

function jsonResponse (body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse (events) {
  const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return { body, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) }
}

function createAnthropicRequest () {
  return {
    model: 'claude-opus-4-1-20250805',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Hi' }],
  }
}

function messageStreamEvents () {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-1-20250805',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

/**
 * Stands in for AI Guard's interceptor: evaluates one branch of the stream and delivers the other.
 *
 * @param {Array<object>} seen collects every event the evaluation observed
 */
function interceptStream (seen) {
  return async stream => {
    const [inspection, delivery] = stream.tee()
    try {
      for await (const event of inspection) seen.push(event)
    } catch {
      // A broken body is still evaluated on what arrived, exactly as AI Guard treats it.
    }
    return delivery
  }
}

function createStream (chunks) {
  return {
    [Symbol.asyncIterator] () {
      let index = 0
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined }),
      }
    },
  }
}

describe('anthropic interception', () => {
  let Messages

  before(() => {
    const hookCallbacks = loadAnthropicInstrumentation()
    applyShim(hookCallbacks, 'resources/messages/messages', FakeMessages)
  })

  beforeEach(() => {
    Messages = class extends FakeMessages {}
  })

  it('calls original directly when nothing is subscribed', () => {
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
      .then(result => assert.strictEqual(result, body))
  })

  it('publishes the native call data once', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    const args = [{ messages: [{ role: 'user', content: 'Hi' }] }]
    return messages.create(...args).parse()
      .then(() => {
        assert.strictEqual(calls.length, 1)
        assert.deepStrictEqual(calls[0].arguments, args)
        assert.ok(calls[0].tracingContext)
      })
      .finally(unsubscribe)
  })

  it('lets a subscriber replace the delivered body', () => {
    const replacement = { role: 'assistant', content: [{ type: 'text', text: 'redacted' }] }
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.onResult = () => replacement
    })
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
      .then(body => assert.strictEqual(body, replacement))
      .finally(unsubscribe)
  })

  it('sends the arguments a call subscriber substituted, and tags the span with them', () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    let asyncEndCtx
    const apmHandlers = { start () {}, asyncEnd (ctx) { asyncEndCtx = ctx } }
    apmChannel.subscribe(apmHandlers)
    const prepare = subscribeSnapshottingCall()
    const { unsubscribe } = subscribeIntercept()

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const options = { messages: [{ role: 'user', content: 'original' }] }

    const apiPromise = messages.create(options)
    options.messages[0].content = 'mutated'

    return apiPromise.parse()
      .then(() => {
        assert.strictEqual(messages.sentArgs[0].messages[0].content, 'original')
        assert.strictEqual(asyncEndCtx.options.messages[0].content, 'original')
      })
      .finally(() => {
        apmChannel.unsubscribe(apmHandlers)
        prepare.unsubscribe()
        unsubscribe()
      })
  })

  it('passes the caller arguments through untouched with no call subscriber', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
    const options = { messages: [{ role: 'user', content: 'original' }] }

    return messages.create(options).parse()
      .then(() => assert.strictEqual(calls[0].arguments[0], options))
      .finally(unsubscribe)
  })

  it('finishes the span only after beforeResult and onResult settle', () => {
    const order = []
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => Promise.resolve().then(() => order.push('beforeResult'))
      ctx.onResult = body => Promise.resolve().then(() => {
        order.push('onResult')
        return body
      })
    })
    const apmChannel = tracingChannel('apm:anthropic:request')
    const apmHandlers = { start () {}, asyncEnd () { order.push('asyncEnd') } }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
      .then(() => assert.deepStrictEqual(order, ['beforeResult', 'onResult', 'asyncEnd']))
      .finally(() => {
        apmChannel.unsubscribe(apmHandlers)
        unsubscribe()
      })
  })

  it('marks the span errored when beforeResult rejects', () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => Promise.reject(err)
    })
    const apmChannel = tracingChannel('apm:anthropic:request')
    let erroredCtx
    const apmHandlers = { start () {}, error (ctx) { erroredCtx = ctx } }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    return assert.rejects(
      () => messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
      e => e === err
    )
      .then(() => assert.strictEqual(erroredCtx?.error, err))
      .finally(() => {
        apmChannel.unsubscribe(apmHandlers)
        unsubscribe()
      })
  })

  it('hands text() callers their raw string and onResult the decoded body', async () => {
    const seen = []
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.onResult = body => {
        seen.push(body)
        return body
      }
    })
    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    try {
      const response = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()

      assert.strictEqual(await response.text(), JSON.stringify(body))
      assert.deepStrictEqual(seen, [body])
    } finally {
      unsubscribe()
    }
  })

  it('applies both callbacks and finishes the span on the withResponse() path', async () => {
    const apmChannel = tracingChannel('apm:anthropic:request')
    let asyncEndCtx
    const apmHandlers = { start () {}, asyncEnd (ctx) { asyncEndCtx = ctx } }
    apmChannel.subscribe(apmHandlers)
    const order = []
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => Promise.resolve().then(() => order.push('beforeResult'))
      ctx.onResult = body => Promise.resolve().then(() => {
        order.push('onResult')
        return body
      })
    })

    const body = { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(body)

    try {
      const { data, response } = await messages.create({ messages: [{ role: 'user', content: 'Hi' }] })
        .withResponse()

      assert.strictEqual(data, body)
      assert.ok(response.ok)
      // `withResponse()` consumes parse() and asResponse(), and each holds on beforeResult;
      // collapsing those into one evaluation is the subscriber's job, not this instrumentation's.
      assert.ok(order.length > 1 && order.every((step, i) => step === (i === order.length - 1
        ? 'onResult'
        : 'beforeResult')), `unexpected order: ${order}`)
      assert.strictEqual(asyncEndCtx?.finished, true)
    } finally {
      apmChannel.unsubscribe(apmHandlers)
      unsubscribe()
    }
  })

  it('propagates a beforeResult rejection through withResponse()', () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => Promise.reject(err)
    })
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })

    return assert.rejects(
      () => messages.create({ messages: [{ role: 'user', content: 'Hi' }] }).withResponse(),
      e => e === err
    ).finally(unsubscribe)
  })

  for (const [first, second] of [['asResponse', 'parse'], ['parse', 'asResponse'], ['withResponse', 'parse']]) {
    it(`runs onResult and finishes the span once when ${first}() and ${second}() share a call`, async () => {
      const apmChannel = tracingChannel('apm:anthropic:request')
      let asyncEndCount = 0
      const apmHandlers = { start () {}, asyncEnd () { asyncEndCount++ } }
      apmChannel.subscribe(apmHandlers)
      let onResultCount = 0
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = body => {
          onResultCount++
          return body
        }
      })

      const messages = new Messages()
      messages._nextApiPromise = new FakeAPIPromise({ role: 'assistant', content: [] })
      const apiPromise = messages.create({ messages: [{ role: 'user', content: 'Hi' }] })

      try {
        await Promise.all([apiPromise[first](), apiPromise[second]()])

        assert.strictEqual(onResultCount, 1)
        assert.strictEqual(asyncEndCount, 1)
      } finally {
        apmChannel.unsubscribe(apmHandlers)
        unsubscribe()
      }
    })
  }

  it('publishes streamed calls to an interceptor without changing the stream', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const chunks = [{ type: 'content_block_delta' }]
    const streamBody = createStream(chunks)
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(streamBody)

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
      .then(body => {
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].arguments[0].stream, true)
        assert.strictEqual(body, streamBody)
      })
      .finally(unsubscribe)
  })

  it('snapshots streamed input before later caller mutation', () => {
    const prepare = subscribeSnapshottingCall()
    const { calls, unsubscribe } = subscribeIntercept()
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(createStream([]))
    const options = { messages: [{ role: 'user', content: 'original' }], stream: true }

    const apiPromise = messages.create(options)
    options.messages[0].content = 'mutated'

    return apiPromise.parse()
      .then(() => {
        assert.strictEqual(messages.sentArgs[0].messages[0].content, 'original')
        assert.strictEqual(calls[0].arguments[0].messages[0].content, 'original')
      })
      .finally(() => {
        prepare.unsubscribe()
        unsubscribe()
      })
  })

  it('delivers the stream returned by the interceptor', () => {
    const original = createStream([{ type: 'content_block_delta', value: 'original' }])
    const replacement = createStream([{ type: 'content_block_delta', value: 'replacement' }])
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.onResult = () => replacement
    })
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(original)

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
      .then(body => assert.strictEqual(body, replacement))
      .finally(unsubscribe)
  })

  it('rejects the streamed call and marks the span errored when onResult rejects', () => {
    const error = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.onResult = () => Promise.reject(error)
    })
    const apmChannel = tracingChannel('apm:anthropic:request')
    let erroredCtx
    const apmHandlers = { start () {}, error (ctx) { erroredCtx = ctx } }
    apmChannel.subscribe(apmHandlers)

    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(createStream([{ type: 'content_block_delta' }]))

    return assert.rejects(
      () => messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse(),
      candidate => candidate === error
    )
      .then(() => assert.strictEqual(erroredCtx?.error, error))
      .finally(() => {
        apmChannel.unsubscribe(apmHandlers)
        unsubscribe()
      })
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

    it('sends the substituted arguments, immune to later caller mutation', async () => {
      const prepare = subscribeSnapshottingCall()
      const { unsubscribe } = subscribeIntercept()
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
      const apiPromise = client.messages.create(options)
      options.messages[0].content = 'mutated'

      try {
        await apiPromise.parse()
        assert.strictEqual(sentBody.messages[0].content, 'original')
      } finally {
        prepare.unsubscribe()
        unsubscribe()
      }
    })

    it('finishes the span once when the caller reads the raw response json()', async () => {
      const apmChannel = tracingChannel('apm:anthropic:request')
      let asyncEndCount = 0
      const apmHandlers = { start () {}, asyncEnd () { asyncEndCount++ } }
      apmChannel.subscribe(apmHandlers)

      const body = { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      const apiPromise = clientReturning(jsonResponse(body)).messages.create(createAnthropicRequest())

      try {
        const response = await apiPromise.asResponse()
        assert.deepStrictEqual(await response.json(), body)
        assert.strictEqual(asyncEndCount, 1)
      } finally {
        apmChannel.unsubscribe(apmHandlers)
      }
    })

    it('routes the raw response body through onResult', async () => {
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = body => {
          seen.push(body)
          return body
        }
      })

      const body = { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      const apiPromise = clientReturning(jsonResponse(body)).messages.create(createAnthropicRequest())

      try {
        const response = await apiPromise.asResponse()
        await response.json()
        assert.deepStrictEqual(seen, [body])
      } finally {
        unsubscribe()
      }
    })

    it('inspects a streamed raw response before exposing its SSE body', async () => {
      const apmChannel = tracingChannel('apm:anthropic:request')
      let asyncEndCount = 0
      const apmHandlers = { start () {}, asyncEnd () { asyncEndCount++ } }
      apmChannel.subscribe(apmHandlers)
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = interceptStream(seen)
      })
      const event = { type: 'message_stop' }
      const { body } = sseResponse([event])
      class ExtendedResponse extends Response {}
      const rawResponse = new ExtendedResponse(body, { headers: { 'content-type': 'text/event-stream' } })
      rawResponse.customState = { endpoint: 'custom' }
      const options = { ...createAnthropicRequest(), stream: true }

      try {
        const response = await clientReturning(rawResponse).messages.create(options).asResponse()

        assert.strictEqual(response, rawResponse)
        assert.deepStrictEqual(response.customState, { endpoint: 'custom' })
        assert.deepStrictEqual(seen, [event])
        assert.strictEqual(await response.text(), body)
        assert.strictEqual(asyncEndCount, 1)
      } finally {
        apmChannel.unsubscribe(apmHandlers)
        unsubscribe()
      }
    })

    it('leaves the caller request alive when the inspected stream fails', async () => {
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = interceptStream(seen)
      })
      const delivered = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }
      // The SDK throws out of its SSE iterator here, whose teardown aborts the request controller.
      const { body } = sseResponse([delivered, { type: 'error', error: { type: 'overloaded_error' } }])
      const rawResponse = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      let requestSignal
      const client = new Anthropic({
        apiKey: 'test',
        fetch: (url, init) => {
          requestSignal = init.signal
          return Promise.resolve(rawResponse)
        },
      })
      const options = { ...createAnthropicRequest(), stream: true }

      try {
        const response = await client.messages.create(options).asResponse()

        assert.deepStrictEqual(seen, [delivered])
        assert.strictEqual(requestSignal.aborted, false)
        assert.strictEqual(await response.text(), body)
      } finally {
        unsubscribe()
      }
    })

    it('copies the raw body only for callers that also read it', async () => {
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = interceptStream(seen)
      })
      const events = messageStreamEvents()
      const { response: rawResponse } = sseResponse(events)
      let copies = 0
      const clone = rawResponse.clone.bind(rawResponse)
      rawResponse.clone = () => {
        copies++
        return clone()
      }
      const options = { ...createAnthropicRequest(), stream: true }

      try {
        const stream = await clientReturning(rawResponse).messages.create(options)
        for await (const event of stream) assert.ok(event.type)

        assert.strictEqual(seen.length, events.length)
        // Nobody asked for the raw response, so the SDK reads the body directly.
        assert.strictEqual(copies, 0)
      } finally {
        unsubscribe()
      }
    })

    it('settles withResponse() and keeps the raw body when the stream fails', async () => {
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = interceptStream(seen)
      })
      const delivered = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }
      const { body } = sseResponse([delivered, { type: 'error', error: { type: 'overloaded_error' } }])
      const rawResponse = new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      let requestSignal
      const client = new Anthropic({
        apiKey: 'test',
        fetch: (url, init) => {
          requestSignal = init.signal
          return Promise.resolve(rawResponse)
        },
      })
      const options = { ...createAnthropicRequest(), stream: true }

      try {
        // Cancelling a live clone would block on the caller's unread branch; the copy must be
        // detached so this resolves at all.
        const { response } = await client.messages.create(options).withResponse()

        assert.deepStrictEqual(seen, [delivered])
        assert.strictEqual(requestSignal.aborted, false)
        assert.strictEqual(await response.text(), body)
      } finally {
        unsubscribe()
      }
    })

    it('reuses the readable response for repeated streamed asResponse() calls', async () => {
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = interceptStream(seen)
      })
      const event = { type: 'message_stop' }
      const { body, response: rawResponse } = sseResponse([event])
      const options = { ...createAnthropicRequest(), stream: true }
      const apiPromise = clientReturning(rawResponse).messages.create(options)

      try {
        const firstResponse = await apiPromise.asResponse()
        const secondResponse = await apiPromise.asResponse()

        assert.strictEqual(secondResponse, firstResponse)
        assert.deepStrictEqual(seen, [event])
        assert.strictEqual(await secondResponse.text(), body)
      } finally {
        unsubscribe()
      }
    })

    it('rejects every streamed asResponse() reader when inspection denies the output', async () => {
      const error = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      let inspectionStarted
      const started = new Promise(resolve => { inspectionStarted = resolve })
      let deny
      const denied = new Promise((resolve, reject) => { deny = reject })
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = () => {
          inspectionStarted()
          return denied
        }
      })
      const { response } = sseResponse([{ type: 'message_stop' }])
      const options = { ...createAnthropicRequest(), stream: true }
      const apiPromise = clientReturning(response).messages.create(options)

      try {
        const first = apiPromise.asResponse()
        await started
        const second = apiPromise.asResponse()
        const rejections = [first, second].map(result => assert.rejects(result, candidate => candidate === error))

        deny(error)
        await Promise.all(rejections)
      } finally {
        unsubscribe()
      }
    })

    for (const reader of ['parse()', 'withResponse()', 'await']) {
      it(`keeps ${reader} readable after streamed asResponse() inspection`, async () => {
        const inspected = []
        const { unsubscribe } = subscribeIntercept(ctx => {
          ctx.onResult = interceptStream(inspected)
        })
        const event = { type: 'message_stop' }
        const { response: rawResponse } = sseResponse([event])
        const options = { ...createAnthropicRequest(), stream: true }
        const apiPromise = clientReturning(rawResponse).messages.create(options)

        try {
          assert.strictEqual(await apiPromise.asResponse(), rawResponse)

          let stream
          if (reader === 'parse()') {
            stream = await apiPromise.parse()
          } else if (reader === 'withResponse()') {
            const result = await apiPromise.withResponse()
            assert.strictEqual(result.response, rawResponse)
            stream = result.data
          } else {
            stream = await apiPromise
          }

          const delivered = []
          for await (const deliveredEvent of stream) delivered.push(deliveredEvent)
          assert.deepStrictEqual(inspected, [event])
          assert.deepStrictEqual(delivered, [event])
        } finally {
          unsubscribe()
        }
      })
    }

    it('keeps a streamed raw response readable through withResponse()', async () => {
      const apmChannel = tracingChannel('apm:anthropic:request')
      let asyncEndCount = 0
      const apmHandlers = { start () {}, asyncEnd () { asyncEndCount++ } }
      apmChannel.subscribe(apmHandlers)
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = interceptStream(seen)
      })
      const event = { type: 'message_stop' }
      const { body } = sseResponse([event])
      class ExtendedResponse extends Response {}
      const rawResponse = new ExtendedResponse(body, { headers: { 'content-type': 'text/event-stream' } })
      rawResponse.customState = { endpoint: 'custom' }
      const options = { ...createAnthropicRequest(), stream: true }

      try {
        const { response, data } = await clientReturning(rawResponse).messages.create(options).withResponse()

        assert.strictEqual(response, rawResponse)
        assert.deepStrictEqual(response.customState, { endpoint: 'custom' })
        assert.deepStrictEqual(seen, [event])
        assert.strictEqual(await response.text(), body)
        // The caller still holds the stream, so the span must stay open until it is drained.
        assert.strictEqual(asyncEndCount, 0)

        const delivered = []
        for await (const deliveredEvent of data) delivered.push(deliveredEvent)

        assert.deepStrictEqual(delivered, [event])
        assert.strictEqual(asyncEndCount, 1)
      } finally {
        apmChannel.unsubscribe(apmHandlers)
        unsubscribe()
      }
    })

    it('keeps messages.stream() readable', async () => {
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = stream => stream
      })
      const events = messageStreamEvents()
      const { response } = sseResponse(events)

      try {
        const stream = clientReturning(response).messages.stream(createAnthropicRequest())
        const seen = []
        for await (const event of stream) seen.push(event)
        assert.deepStrictEqual(seen.map(event => event.type), events.map(event => event.type))
      } finally {
        unsubscribe()
      }
    })

    // `messages.stream()` reaches the SDK through `withResponse()`, which resolves the raw response
    // as soon as the headers arrive; the span must still close on the last chunk instead.
    for (const intercepting of [false, true]) {
      it(`publishes every messages.stream() chunk before closing the span${
        intercepting ? ' while intercepting' : ''}`, async () => {
        const apmChannel = tracingChannel('apm:anthropic:request')
        const chunkChannel = channel('apm:anthropic:request:chunk')
        const published = []
        const apmHandlers = { start () {}, asyncEnd () { published.push('asyncEnd') } }
        const onChunk = ({ chunk, done }) => published.push(done ? 'done' : chunk.type)
        apmChannel.subscribe(apmHandlers)
        chunkChannel.subscribe(onChunk)
        const intercept = intercepting ? subscribeIntercept(ctx => { ctx.onResult = stream => stream }) : undefined
        const events = messageStreamEvents()
        const { response } = sseResponse(events)

        try {
          const stream = clientReturning(response).messages.stream(createAnthropicRequest())
          for await (const event of stream) assert.ok(event.type)

          assert.deepStrictEqual(published, [...events.map(event => event.type), 'done', 'asyncEnd'])
        } finally {
          apmChannel.unsubscribe(apmHandlers)
          chunkChannel.unsubscribe(onChunk)
          intercept?.unsubscribe()
        }
      })
    }

    for (const [failure, breakClone] of [
      ['cloning fails', response => { response.clone = () => { throw new Error('locked body') } }],
      ['reading the clone fails', response => {
        response.clone = () => ({ arrayBuffer: () => Promise.reject(new Error('broken body')) })
      }],
    ]) {
      it(`keeps a direct streamed raw response readable when ${failure}`, async () => {
        const { unsubscribe } = subscribeIntercept(ctx => {
          ctx.onResult = stream => stream
        })
        const { body, response } = sseResponse([{ type: 'message_stop' }])
        breakClone(response)
        const options = { ...createAnthropicRequest(), stream: true }

        try {
          const rawResponse = await clientReturning(response).messages.create(options).asResponse()

          assert.strictEqual(rawResponse, response)
          assert.strictEqual(rawResponse.bodyUsed, false)
          assert.strictEqual(await rawResponse.text(), body)
        } finally {
          unsubscribe()
        }
      })
    }

    it('does not expose a streamed raw response when onResult rejects', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = () => Promise.reject(err)
      })
      const { response } = sseResponse([{ type: 'message_stop' }])
      const options = { ...createAnthropicRequest(), stream: true }

      try {
        await assert.rejects(
          () => clientReturning(response).messages.create(options).asResponse(),
          error => error === err
        )
      } finally {
        unsubscribe()
      }
    })

    it('routes a cloned response through onResult and propagates its rejection', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = () => Promise.reject(err)
      })

      const body = { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }
      const apiPromise = clientReturning(jsonResponse(body)).messages.create(createAnthropicRequest())

      try {
        const response = await apiPromise.asResponse()
        await assert.rejects(() => response.clone().json(), e => e === err)
      } finally {
        unsubscribe()
      }
    })

    it('fails open for a malformed raw response and preserves custom state', async () => {
      const seen = []
      const { unsubscribe } = subscribeIntercept(ctx => {
        ctx.onResult = body => {
          seen.push(body)
          return body
        }
      })

      const rawResponse = new Response('not JSON', { headers: { 'content-type': 'application/json' } })
      rawResponse.customState = { endpoint: 'custom' }

      try {
        const response = await clientReturning(rawResponse).messages.create(createAnthropicRequest()).asResponse()

        assert.strictEqual(response, rawResponse)
        assert.deepStrictEqual(response.customState, { endpoint: 'custom' })
        assert.strictEqual(await response.text(), 'not JSON')
        assert.deepStrictEqual(seen, [])
      } finally {
        unsubscribe()
      }
    })
  })
})
