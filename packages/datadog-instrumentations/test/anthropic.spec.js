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

function createAnthropicRequest () {
  return {
    model: 'claude-opus-4-1-20250805',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Hi' }],
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

  it('leaves a stream to the native call and hands the async iterable back untouched', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const chunks = [{ type: 'content_block_delta' }]
    const streamBody = {
      [Symbol.asyncIterator] () {
        let index = 0
        return {
          next: () => Promise.resolve(index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined }),
        }
      },
    }
    const messages = new Messages()
    messages._nextApiPromise = new FakeAPIPromise(streamBody)

    return messages.create({ messages: [{ role: 'user', content: 'Hi' }], stream: true }).parse()
      .then(body => {
        assert.deepStrictEqual(calls, [])
        assert.strictEqual(body, streamBody)
      })
      .finally(unsubscribe)
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
