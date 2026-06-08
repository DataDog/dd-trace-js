'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const aiGuard = require('../../src/helpers/openai-ai-guard')

const evaluateChannel = channel('dd-trace:ai:aiguard')

describe('openai-ai-guard helper', () => {
  let handler
  let calls

  beforeEach(() => {
    calls = []
    handler = ctx => {
      calls.push({ messages: ctx.messages, integration: ctx.integration, parentSpan: ctx.parentSpan })
      ctx.resolve()
    }
    evaluateChannel.subscribe(handler)
  })

  afterEach(() => {
    evaluateChannel.unsubscribe(handler)
  })

  describe('hasSubscribers', () => {
    it('reflects channel subscriber state', () => {
      assert.strictEqual(aiGuard.hasSubscribers(), true)
      evaluateChannel.unsubscribe(handler)
      assert.strictEqual(aiGuard.hasSubscribers(), false)
      evaluateChannel.subscribe(handler)
      assert.strictEqual(aiGuard.hasSubscribers(), true)
    })
  })

  describe('createGuard', () => {
    it('returns null for streaming calls', () => {
      const guard = aiGuard.createGuard('chat.completions', { messages: [{ role: 'user', content: 'hi' }] }, true)
      assert.strictEqual(guard, null)
    })

    it('returns null for non-conversational resources', () => {
      const guard = aiGuard.createGuard('embeddings', { input: 'hi' }, false)
      assert.strictEqual(guard, null)
    })

    it('returns null when chat.completions has no messages', () => {
      const guard = aiGuard.createGuard('chat.completions', {}, false)
      assert.strictEqual(guard, null)
    })

    it('returns null when responses has no input or instructions', () => {
      const guard = aiGuard.createGuard('responses', {}, false)
      assert.strictEqual(guard, null)
    })

    it('builds a guard with input messages and a bound handler for chat.completions', () => {
      const callArgs = { messages: [{ role: 'user', content: 'hi' }] }
      const guard = aiGuard.createGuard('chat.completions', callArgs, false)
      assert.deepStrictEqual(guard.inputMessages, callArgs.messages)
      assert.strictEqual(typeof guard.handler.getOutputMessages, 'function')
      assert.strictEqual(typeof guard.handler.publishOutputEvaluation, 'function')
      assert.strictEqual(typeof guard.getInputEval, 'function')
    })

    it('forwards `guard.parentSpan` on Before and After Model publishes', async () => {
      const span = { fake: 'openai.request span' }
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      guard.parentSpan = span
      await guard.getInputEval()
      await aiGuard.evaluateOutput(guard, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })
      assert.strictEqual(calls.length, 2)
      assert.strictEqual(calls[0].parentSpan, span)
      assert.strictEqual(calls[1].parentSpan, span)
    })

    it('memoizes getInputEval across calls', () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      const p1 = guard.getInputEval()
      const p2 = guard.getInputEval()
      assert.strictEqual(p1, p2)
      return Promise.all([p1, p2])
    })

    it('uses `instructions` alone when the first developer message has empty content', () => {
      const guard = aiGuard.createGuard(
        'responses',
        {
          input: [{ type: 'message', role: 'developer', content: '' }],
          instructions: 'Be brief.',
        },
        false
      )
      assert.deepStrictEqual(guard.inputMessages, [{ role: 'developer', content: 'Be brief.' }])
    })

    it('prepends `instructions` as a new developer message when first message is a user turn', () => {
      const guard = aiGuard.createGuard(
        'responses',
        {
          input: [{ type: 'message', role: 'user', content: 'hello' }],
          instructions: 'Be brief.',
        },
        false
      )
      assert.deepStrictEqual(guard.inputMessages, [
        { role: 'developer', content: 'Be brief.' },
        { role: 'user', content: 'hello' },
      ])
    })

    it('returns an `instructions`-only developer message when no input is provided', () => {
      const guard = aiGuard.createGuard('responses', { instructions: 'Be brief.' }, false)
      assert.deepStrictEqual(guard.inputMessages, [{ role: 'developer', content: 'Be brief.' }])
    })

    it('concatenates `instructions` with non-empty string content on the first developer message', () => {
      const guard = aiGuard.createGuard(
        'responses',
        {
          input: [{ type: 'message', role: 'system', content: 'existing rule' }],
          instructions: 'Be brief.',
        },
        false
      )
      assert.deepStrictEqual(guard.inputMessages, [
        { role: 'developer', content: 'Be brief.\n\nexisting rule' },
      ])
    })

    it('prepends `instructions` as a text part when first developer message has array content', () => {
      const guard = aiGuard.createGuard(
        'responses',
        {
          input: [{
            type: 'message',
            role: 'developer',
            content: [
              { type: 'input_text', text: 'rule one' },
              { type: 'input_image', image_url: 'http://example.com/x.png' },
            ],
          }],
          instructions: 'Be brief.',
        },
        false
      )
      assert.strictEqual(guard.inputMessages.length, 1)
      assert.strictEqual(guard.inputMessages[0].role, 'developer')
      assert.deepStrictEqual(guard.inputMessages[0].content[0], { type: 'text', text: 'Be brief.' })
    })

    it('returns null when responses input is provided but contains only unsupported items', () => {
      const guard = aiGuard.createGuard('responses', { input: [{ type: 'unknown' }] }, false)
      assert.strictEqual(guard, null)
    })
  })

  describe('evaluateOutput', () => {
    it('resolves without publishing when chat.completions has no choices', async () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      // Drain the Before Model publish so we only observe After Model below.
      await guard.getInputEval()
      const beforeAfter = calls.length

      await aiGuard.evaluateOutput(guard, { choices: [] })
      assert.strictEqual(calls.length, beforeAfter, 'no After Model publish for empty output')
    })

    it('resolves without publishing when chat.completions body has no choices array', async () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      await guard.getInputEval()
      const beforeAfter = calls.length

      await aiGuard.evaluateOutput(guard, {})
      assert.strictEqual(calls.length, beforeAfter)
    })

    it('skips chat.completions choices whose message lacks any output fields', async () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      await guard.getInputEval()
      calls.length = 0

      await aiGuard.evaluateOutput(guard, {
        choices: [
          { message: { role: 'assistant' } },
          { message: { role: 'assistant', refusal: 'no' } },
          { message: { role: 'assistant', function_call: { name: 'f', arguments: '{}' } } },
          { message: { role: 'assistant', tool_calls: [{ id: 't', function: { name: 'f', arguments: '{}' } }] } },
        ],
      })
      assert.strictEqual(calls.length, 3)
    })

    it('resolves without publishing when responses has empty output items', async () => {
      const guard = aiGuard.createGuard('responses', { input: 'hi' }, false)
      await guard.getInputEval()
      const beforeAfter = calls.length

      await aiGuard.evaluateOutput(guard, { output: [] })
      assert.strictEqual(calls.length, beforeAfter)
    })

    it('publishes one evaluation per choice for chat.completions', async () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      await guard.getInputEval()
      calls.length = 0

      await aiGuard.evaluateOutput(guard, {
        choices: [
          { message: { role: 'assistant', content: 'one' } },
          { message: { role: 'assistant', content: 'two' } },
        ],
      })
      assert.strictEqual(calls.length, 2)
      assert.deepStrictEqual(calls[0].messages.at(-1), { role: 'assistant', content: 'one' })
      assert.deepStrictEqual(calls[1].messages.at(-1), { role: 'assistant', content: 'two' })
    })

    it('publishes one combined evaluation for responses output items', async () => {
      const guard = aiGuard.createGuard('responses', { input: 'hi' }, false)
      await guard.getInputEval()
      calls.length = 0

      await aiGuard.evaluateOutput(guard, {
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
          { type: 'function_call', call_id: 'c1', name: 'do_x', arguments: '{}' },
        ],
      })
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].messages.length, 3) // user input + 2 output items
    })
  })

  describe('gateParse', () => {
    it('resolves to the SDK result after the Before Model publish settles', async () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      const sdkResult = { body: 'parsed' }
      const result = await aiGuard.gateParse(Promise.resolve(sdkResult), guard)
      assert.strictEqual(result, sdkResult)
    })

    it('rejects when Before Model evaluation rejects', () => {
      evaluateChannel.unsubscribe(handler)
      const rejectHandler = ctx => ctx.reject(Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' }))
      evaluateChannel.subscribe(rejectHandler)
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      const promise = aiGuard.gateParse(Promise.resolve({ ok: true }), guard)
      return assert.rejects(promise, e => e.name === 'AIGuardAbortError')
        .finally(() => {
          evaluateChannel.unsubscribe(rejectHandler)
          evaluateChannel.subscribe(handler)
        })
    })
  })

  describe('wrapAsResponse', () => {
    it('no-ops when apiProm has no asResponse method', () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      const apiProm = { parse: () => Promise.resolve({}) }
      // Should not throw and should not add an asResponse method.
      aiGuard.wrapAsResponse(apiProm, guard)
      assert.strictEqual(typeof apiProm.asResponse, 'undefined')
    })

    it('gates the raw response on Before Model evaluation', async () => {
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      const rawResponse = { status: 200 }
      const apiProm = { asResponse: () => Promise.resolve(rawResponse) }
      aiGuard.wrapAsResponse(apiProm, guard)
      const result = await apiProm.asResponse()
      assert.strictEqual(result, rawResponse)
      assert.strictEqual(calls.length, 1)
    })

    it('propagates Before Model rejection through asResponse', () => {
      evaluateChannel.unsubscribe(handler)
      const rejectHandler = ctx => ctx.reject(Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' }))
      evaluateChannel.subscribe(rejectHandler)
      const guard = aiGuard.createGuard(
        'chat.completions',
        { messages: [{ role: 'user', content: 'hi' }] },
        false
      )
      const apiProm = { asResponse: () => Promise.resolve({ status: 200 }) }
      aiGuard.wrapAsResponse(apiProm, guard)
      return assert.rejects(apiProm.asResponse(), e => e.name === 'AIGuardAbortError')
        .finally(() => {
          evaluateChannel.unsubscribe(rejectHandler)
          evaluateChannel.subscribe(handler)
        })
    })
  })
})
