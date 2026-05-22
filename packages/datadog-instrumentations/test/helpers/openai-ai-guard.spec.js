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
      calls.push({ messages: ctx.messages, integration: ctx.integration })
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
  })
})
