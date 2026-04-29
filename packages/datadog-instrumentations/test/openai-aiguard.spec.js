'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const { before, beforeEach, describe, it } = require('mocha')

const evaluateChannel = channel('apm:openai:request:evaluate')

// Minimal APIPromise stand-in. The real SDK APIPromise has a `parse()` method that
// returns the parsed response body, and user-facing `.then` routes through `.parse()`.
// The instrumentation patches `parse()` rather than `then()` to preserve the APIPromise
// surface (`.withResponse()` etc.).
class FakeAPIPromise {
  constructor (body, responsePromise = Promise.resolve({ response: { headers: {}, url: '/' }, options: {} })) {
    this._body = body
    this.responsePromise = responsePromise
    this._rawResponse = { ok: true }
  }

  parse () {
    return Promise.resolve(this._body)
  }

  // Mirrors openai SDK's APIPromise.asResponse which returns the raw Response without
  // parsing the body. AI Guard must still gate Before Model rejection on this path.
  asResponse () {
    return Promise.resolve(this._rawResponse)
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
  evaluateChannel.subscribe(handler)
  return { calls, unsubscribe: () => evaluateChannel.unsubscribe(handler) }
}

function subscribeWithHandler (handler) {
  evaluateChannel.subscribe(handler)
  return () => evaluateChannel.unsubscribe(handler)
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
          // Before Model + After Model (assistant responded)
          assert.strictEqual(calls.length, 2)
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
      // publishEvaluation, which happens right after methodFn is invoked. So by the time
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

    it('evaluates every choice when n > 1', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [
          { message: { role: 'assistant', content: 'safe one' } },
          { message: { role: 'assistant', content: 'safe two' } },
          { message: { role: 'assistant', content: 'safe three' } },
        ],
      })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }], n: 3 }).parse()
        .then(() => {
          // 1 Before Model + 3 After Model (one per choice)
          assert.strictEqual(calls.length, 4)
          assert.deepStrictEqual(calls[1].messages[1], { role: 'assistant', content: 'safe one' })
          assert.deepStrictEqual(calls[2].messages[1], { role: 'assistant', content: 'safe two' })
          assert.deepStrictEqual(calls[3].messages[1], { role: 'assistant', content: 'safe three' })
        })
        .finally(unsubscribe)
    })

    it('rejects when any choice fails After Model evaluation', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      let count = 0
      const unsubscribe = subscribeWithHandler(ctx => {
        count++
        // Before Model passes; first choice passes; second choice rejects
        count === 3 ? ctx.reject(err) : ctx.resolve()
      })
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [
          { message: { role: 'assistant', content: 'safe' } },
          { message: { role: 'assistant', content: 'unsafe' } },
        ],
      })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }], n: 2 }).parse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('propagates Before Model rejection through asResponse()', () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => ctx.reject(err))
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })

      return assert.rejects(
        () => completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse(),
        e => e === err
      ).finally(unsubscribe)
    })

    it('returns the raw response from asResponse() when Before Model resolves', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      const apiProm = new FakeAPIPromise({ choices: [{ message: { role: 'assistant', content: 'x' } }] })
      completions._nextApiPromise = apiProm

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).asResponse()
        .then(resp => assert.strictEqual(resp, apiProm._rawResponse))
        .finally(unsubscribe)
    })

    it('passes a multi-turn system + user + assistant + tool conversation verbatim', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: 'sure' } }],
      })

      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Look up the weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookupWeather', arguments: '{"city":"NY"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 25C' },
        { role: 'user', content: 'Thanks' },
      ]
      return completions.create({ messages }).parse()
        .then(() => {
          assert.deepStrictEqual(calls[0].messages, messages)
          // After Model adds the assistant response
          assert.deepStrictEqual(calls[1].messages.at(-1), { role: 'assistant', content: 'sure' })
        })
        .finally(unsubscribe)
    })

    it('passes multimodal user content (text + image_url) through verbatim', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: 'a cat' } }],
      })

      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      }]
      return completions.create({ messages, model: 'gpt-4o-mini' }).parse()
        .then(() => assert.deepStrictEqual(calls[0].messages, messages))
        .finally(unsubscribe)
    })

    it('skips Before Model when messages is an empty array', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [] })

      return completions.create({ messages: [] }).parse()
        .then(() => assert.strictEqual(calls.length, 0))
        .finally(unsubscribe)
    })

    it('After Model includes the assistant message when only `refusal` is set', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const refusalMessage = { role: 'assistant', content: null, refusal: 'I cannot help with that' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: refusalMessage }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].messages.at(-1), refusalMessage)
        })
        .finally(unsubscribe)
    })

    it('After Model includes the assistant message when content is the empty string', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const emptyMessage = { role: 'assistant', content: '' }
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({ choices: [{ message: emptyMessage }] })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => {
          assert.strictEqual(calls.length, 2)
          assert.deepStrictEqual(calls[1].messages.at(-1), emptyMessage)
        })
        .finally(unsubscribe)
    })

    it('skips After Model when assistant message has no content, tool_calls, or refusal', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [] } }],
      })

      return completions.create({ messages: [{ role: 'user', content: 'Hi' }] }).parse()
        .then(() => assert.strictEqual(calls.length, 1))
        .finally(unsubscribe)
    })

    it('does not start Before Model evaluation until APIPromise is consumed', async () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completions = new Completions()
      completions._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: 'x' } }],
      })

      try {
        const apiProm = completions.create({ messages: [{ role: 'user', content: 'Hi' }] })

        // Let microtasks drain. Lazy memoization means no publish without a consumer.
        await new Promise(resolve => setImmediate(resolve))
        assert.strictEqual(calls.length, 0, 'Before Model must not start until apiProm is awaited')

        await apiProm.parse()
        assert.strictEqual(calls.length, 2, 'Before + After Model must have run after parse()')
      } finally {
        unsubscribe()
      }
    })

    it('does not emit unhandled rejection when apiProm is discarded and Before Model would deny', async () => {
      const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
      const unsubscribe = subscribeWithHandler(ctx => ctx.reject(err))

      const observed = []
      const onUnhandled = reason => observed.push(reason)
      process.on('unhandledRejection', onUnhandled)

      try {
        const completions = new Completions()
        completions._nextApiPromise = new FakeAPIPromise({
          choices: [{ message: { role: 'assistant', content: 'x' } }],
        })

        // Discard the apiProm without awaiting parse() or asResponse().
        completions.create({ messages: [{ role: 'user', content: 'Hi' }] })

        // Drain enough microtasks for Node to surface unhandled rejections, if any.
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))

        assert.deepStrictEqual(observed, [])
      } finally {
        process.removeListener('unhandledRejection', onUnhandled)
        unsubscribe()
      }
    })

    it('rejects with the OpenAI error when the SDK call rejects', () => {
      const { unsubscribe } = subscribeAutoResolve()
      const sdkErr = new Error('upstream HTTP failure')
      class RejectingCompletions {
        create () {
          return {
            parse () { return Promise.reject(sdkErr) },
            asResponse () { return Promise.reject(sdkErr) },
            then (onF, onR) { return this.parse().then(onF, onR) },
            responsePromise: Promise.reject(sdkErr),
          }
        }
      }
      RejectingCompletions.prototype._client = { baseURL: 'https://api.openai.com' }
      applyShim(hookCallbacks, 'resources/chat/completions', 'Completions', RejectingCompletions)

      return assert.rejects(
        () => new RejectingCompletions().create({ messages: [{ role: 'user', content: 'Hi' }] }).parse(),
        e => e === sdkErr
      ).finally(unsubscribe)
    })

    it('publishes independent evaluations for two concurrent calls', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const completionsA = new Completions()
      const completionsB = new Completions()
      completionsA._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: 'A out' } }],
      })
      completionsB._nextApiPromise = new FakeAPIPromise({
        choices: [{ message: { role: 'assistant', content: 'B out' } }],
      })

      return Promise.all([
        completionsA.create({ messages: [{ role: 'user', content: 'A in' }] }).parse(),
        completionsB.create({ messages: [{ role: 'user', content: 'B in' }] }).parse(),
      ]).then(() => {
        // 2 calls × (Before + After) = 4 evaluations
        assert.strictEqual(calls.length, 4)
        const inputs = calls.filter(c => c.messages.length === 1).map(c => c.messages[0].content)
        assert.deepStrictEqual(inputs.sort(), ['A in', 'B in'])
      }).finally(unsubscribe)
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

    it('converts responses input image parts for Before Model evaluation', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this?' },
            { type: 'input_image', image_url: 'https://example.com/image.png' },
          ],
        }],
      }).parse()
        .then(() => assert.deepStrictEqual(calls[0].messages, [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
          ],
        }]))
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

    it('converts a multi-item input (function_call + function_call_output + message)', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look up the weather' }] },
          { type: 'function_call', call_id: 'c1', name: 'lookupWeather', arguments: '{"city":"NY"}' },
          { type: 'function_call_output', call_id: 'c1', output: 'Sunny, 25C' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] },
        ],
      }).parse()
        .then(() => assert.deepStrictEqual(calls[0].messages, [
          { role: 'user', content: 'Look up the weather' },
          {
            role: 'assistant',
            tool_calls: [{ id: 'c1', function: { name: 'lookupWeather', arguments: '{"city":"NY"}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'Sunny, 25C' },
          { role: 'user', content: 'Thanks' },
        ]))
        .finally(unsubscribe)
    })

    it('handles input_image as object {image_url: {url: ...}}', () => {
      const { calls, unsubscribe } = subscribeAutoResolve()
      const responses = new Responses()
      responses._nextApiPromise = new FakeAPIPromise({ output: [] })

      return responses.create({
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }],
      }).parse()
        .then(() => assert.deepStrictEqual(calls[0].messages, [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }]))
        .finally(unsubscribe)
    })
  })
})
