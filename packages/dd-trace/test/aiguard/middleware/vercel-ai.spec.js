'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { AIGuardMiddleware } = require('../../../src/aiguard/middleware/vercel-ai')

/**
 * Creates a mock AIGuardAbortError (same structure as SDK's AIGuardAbortError)
 * @param {string} reason - The reason for blocking
 * @param {string[]} [tags] - Attack category tags
 * @returns {Error}
 */
function createSDKAbortError (reason, tags) {
  const error = new Error(reason)
  error.name = 'AIGuardAbortError'
  error.reason = reason
  error.tags = tags
  return error
}

/**
 * Creates a mock ReadableStream with the given chunks
 * @param {Array} chunks - The chunks to enqueue
 * @returns {ReadableStream}
 */
function createMockStream (chunks) {
  return new ReadableStream({
    start (controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    }
  })
}

/**
 * Consumes a ReadableStream and returns all chunks
 * @param {ReadableStream} stream - The stream to consume
 * @returns {Promise<Array>}
 */
async function consumeStream (stream) {
  const reader = stream.getReader()
  const chunks = []
  let done = false
  while (!done) {
    const { value, done: d } = await reader.read()
    done = d
    if (value) chunks.push(value)
  }
  return chunks
}

// Shared test fixtures
const basePrompt = [{ role: 'user', content: 'Hello' }]

describe('AIGuardMiddleware', () => {
  let tracer
  let aiguard
  let middleware

  beforeEach(() => {
    aiguard = {
      evaluate: sinon.stub()
    }
    tracer = {
      aiguard
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('constructor', () => {
    it('should throw TypeError if tracer is not provided', () => {
      assert.throws(
        () => new AIGuardMiddleware({}),
        { name: 'TypeError', message: 'AIGuardMiddleware: tracer is required' }
      )
    })

    it('should throw TypeError if tracer is undefined', () => {
      assert.throws(
        () => new AIGuardMiddleware({ tracer: undefined }),
        { name: 'TypeError', message: 'AIGuardMiddleware: tracer is required' }
      )
    })

    it('should create instance with tracer and have specificationVersion v3', () => {
      const mw = new AIGuardMiddleware({ tracer })
      assert.strictEqual(mw.specificationVersion, 'v3')
    })

    it('should default allowOnFailure to true (verified via behavior)', async () => {
      aiguard.evaluate.rejects(new Error('Network error'))
      const mw = new AIGuardMiddleware({ tracer })

      const doGenerate = sinon.stub().resolves({ text: 'Response' })
      const result = await mw.wrapGenerate({ doGenerate, params: { prompt: basePrompt }, model: {} })

      // With allowOnFailure=true (default), request should be allowed despite evaluation failure
      assert.deepStrictEqual(result, { text: 'Response' })
    })

    it('should accept allowOnFailure=false option (verified via behavior)', async () => {
      aiguard.evaluate.rejects(new Error('Network error'))
      const mw = new AIGuardMiddleware({ tracer, allowOnFailure: false })

      const doGenerate = sinon.stub().resolves({ text: 'Response' })

      // With allowOnFailure=false, evaluation failure should throw
      await assert.rejects(
        () => mw.wrapGenerate({ doGenerate, params: { prompt: basePrompt }, model: {} }),
        { name: 'AIGuardMiddlewareClientError' }
      )
    })
  })

  describe('wrapGenerate - prompt evaluation', () => {
    const prompt = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello, how are you?' }
    ]
    const doGenerate = sinon.stub()
    const model = {}
    const params = { prompt }

    beforeEach(() => {
      doGenerate.reset()
      doGenerate.resolves({ text: 'I am fine, thank you!' })
    })

    it('should call SDK.evaluate with { block: true }', async () => {
      aiguard.evaluate.resolves({ action: 'ALLOW', reason: '' })
      middleware = new AIGuardMiddleware({ tracer })

      await middleware.wrapGenerate({ doGenerate, params, model })

      assert.strictEqual(aiguard.evaluate.callCount, 1)
      // Verify block: true is passed
      const callArgs = aiguard.evaluate.firstCall.args
      assert.deepStrictEqual(callArgs[1], { block: true })
    })

    it('should allow request when SDK returns without exception', async () => {
      aiguard.evaluate.resolves({ action: 'ALLOW', reason: '' })
      middleware = new AIGuardMiddleware({ tracer })

      const result = await middleware.wrapGenerate({ doGenerate, params, model })

      assert.deepStrictEqual(result, { text: 'I am fine, thank you!' })
      assert.strictEqual(doGenerate.callCount, 1)
      assert.strictEqual(aiguard.evaluate.callCount, 1)
    })

    it('should throw AIGuardMiddlewareAbortError when SDK throws AIGuardAbortError', async () => {
      aiguard.evaluate.rejects(createSDKAbortError('Sensitive content detected', ['pii']))
      middleware = new AIGuardMiddleware({ tracer })

      await assert.rejects(
        () => middleware.wrapGenerate({ doGenerate, params, model }),
        {
          name: 'AIGuardMiddlewareAbortError',
          code: 'AI_GUARD_MIDDLEWARE_ABORT',
          kind: 'Prompt'
        }
      )
      assert.strictEqual(doGenerate.callCount, 0)
    })

    it('AIGuardMiddlewareAbortError should not expose sensitive fields (security)', async () => {
      aiguard.evaluate.rejects(createSDKAbortError('Sensitive reason', ['injection']))
      middleware = new AIGuardMiddleware({ tracer })

      try {
        await middleware.wrapGenerate({ doGenerate, params, model })
        assert.fail('Expected error to be thrown')
      } catch (error) {
        // Structural safety: sensitive fields must not exist
        assert.ok(!Object.prototype.hasOwnProperty.call(error, 'reason'))
        assert.ok(!Object.prototype.hasOwnProperty.call(error, 'tags'))
        assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'))

        // Serialization safety: sensitive field names must not appear in JSON
        const json = JSON.stringify(error)
        assert.ok(!json.includes('"reason"'))
        assert.ok(!json.includes('"tags"'))
      }
    })
  })

  describe('wrapGenerate - tool call evaluation', () => {
    const prompt = [
      { role: 'user', content: 'What is the weather in Tokyo?' }
    ]
    const model = {}
    const params = { prompt }

    it('should evaluate tool calls with SDK.evaluate({ block: true })', async () => {
      aiguard.evaluate.resolves({ action: 'ALLOW', reason: '' })
      middleware = new AIGuardMiddleware({ tracer })

      const toolCalls = [{
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'getWeather',
        args: { city: 'Tokyo' }
      }]

      const doGenerate = sinon.stub().resolves({
        text: '',
        toolCalls
      })

      await middleware.wrapGenerate({ doGenerate, params, model })

      // First call for prompt, second call for tool call
      assert.strictEqual(aiguard.evaluate.callCount, 2)
      // Both calls should have block: true
      assert.deepStrictEqual(aiguard.evaluate.firstCall.args[1], { block: true })
      assert.deepStrictEqual(aiguard.evaluate.secondCall.args[1], { block: true })
    })

    it('should throw AIGuardMiddlewareAbortError when SDK throws AIGuardAbortError for tool call', async () => {
      aiguard.evaluate.onFirstCall().resolves({ action: 'ALLOW', reason: '' })
      aiguard.evaluate.onSecondCall().rejects(createSDKAbortError('Dangerous operation', ['injection']))
      middleware = new AIGuardMiddleware({ tracer })

      const toolCalls = [{
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'deleteFile',
        args: { path: '/etc/passwd' }
      }]

      const doGenerate = sinon.stub().resolves({
        text: '',
        toolCalls
      })

      await assert.rejects(
        () => middleware.wrapGenerate({ doGenerate, params, model }),
        {
          name: 'AIGuardMiddlewareAbortError',
          code: 'AI_GUARD_MIDDLEWARE_ABORT',
          kind: 'Tool call'
        }
      )
    })

    it('should evaluate tool calls sequentially', async () => {
      aiguard.evaluate.onFirstCall().resolves({ action: 'ALLOW', reason: '' }) // prompt
      aiguard.evaluate.onSecondCall().resolves({ action: 'ALLOW', reason: '' }) // first tool
      aiguard.evaluate.onThirdCall().rejects(createSDKAbortError('Blocked', [])) // second tool
      middleware = new AIGuardMiddleware({ tracer })

      const toolCalls = [
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'safeOp', args: {} },
        { type: 'tool-call', toolCallId: 'call_2', toolName: 'dangerousOp', args: {} },
        { type: 'tool-call', toolCallId: 'call_3', toolName: 'neverReached', args: {} }
      ]

      const doGenerate = sinon.stub().resolves({ text: '', toolCalls })

      await assert.rejects(
        () => middleware.wrapGenerate({ doGenerate, params, model }),
        { name: 'AIGuardMiddlewareAbortError' }
      )

      // Should be 3: prompt + 2 tool calls (third tool never evaluated)
      assert.strictEqual(aiguard.evaluate.callCount, 3)
    })
  })

  describe('wrapGenerate - evaluation failure handling', () => {
    const prompt = [{ role: 'user', content: 'Hello' }]
    const params = { prompt }
    const model = {}
    const doGenerate = sinon.stub()

    beforeEach(() => {
      doGenerate.reset()
      doGenerate.resolves({ text: 'Response' })
    })

    it('allowOnFailure=true allows request when evaluation fails', async () => {
      aiguard.evaluate.rejects(new Error('Network error'))
      middleware = new AIGuardMiddleware({ tracer, allowOnFailure: true })

      const result = await middleware.wrapGenerate({ doGenerate, params, model })

      assert.deepStrictEqual(result, { text: 'Response' })
    })

    it('allowOnFailure=false throws AIGuardMiddlewareClientError when evaluation fails', async () => {
      aiguard.evaluate.rejects(new Error('Service unavailable'))
      middleware = new AIGuardMiddleware({ tracer, allowOnFailure: false })

      await assert.rejects(
        () => middleware.wrapGenerate({ doGenerate, params, model }),
        {
          name: 'AIGuardMiddlewareClientError',
          code: 'AI_GUARD_MIDDLEWARE_CLIENT_ERROR',
          message: 'AI Guard evaluation failed'
        }
      )
    })

    it('AIGuardMiddlewareClientError should not expose original error (security)', async () => {
      aiguard.evaluate.rejects(new Error('Internal: connection string'))
      middleware = new AIGuardMiddleware({ tracer, allowOnFailure: false })

      try {
        await middleware.wrapGenerate({ doGenerate, params, model })
        assert.fail('Expected error to be thrown')
      } catch (error) {
        // Structural safety: cause must not exist
        assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'))
        assert.strictEqual(error.cause, undefined)

        // Serialization safety: cause must not appear in JSON
        const json = JSON.stringify(error)
        assert.ok(!json.includes('"cause"'))
      }
    })

    it('should handle missing aiguard SDK gracefully', async () => {
      tracer.aiguard = undefined
      middleware = new AIGuardMiddleware({ tracer })

      const result = await middleware.wrapGenerate({ doGenerate, params, model })

      assert.deepStrictEqual(result, { text: 'Response' })
    })
  })

  describe('wrapStream - prompt evaluation', () => {
    const prompt = [{ role: 'user', content: 'Tell me a story' }]
    const params = { prompt }
    const model = {}

    it('should evaluate prompt before streaming', async () => {
      aiguard.evaluate.resolves({ action: 'ALLOW', reason: '' })
      middleware = new AIGuardMiddleware({ tracer })

      const mockStream = createMockStream([
        { type: 'text-delta', textDelta: 'Hello' }
      ])

      const doStream = sinon.stub().resolves({
        stream: mockStream,
        response: { headers: {} }
      })

      const result = await middleware.wrapStream({ doStream, params, model })

      assert.ok(result.stream)
      assert.strictEqual(aiguard.evaluate.callCount, 1)
    })

    it('should throw AIGuardMiddlewareAbortError when SDK throws AIGuardAbortError for prompt', async () => {
      aiguard.evaluate.rejects(createSDKAbortError('Blocked prompt', ['malicious']))
      middleware = new AIGuardMiddleware({ tracer })

      const doStream = sinon.stub()

      await assert.rejects(
        () => middleware.wrapStream({ doStream, params, model }),
        {
          name: 'AIGuardMiddlewareAbortError',
          kind: 'Prompt'
        }
      )
      assert.strictEqual(doStream.callCount, 0)
    })
  })

  describe('wrapStream - tool call evaluation', () => {
    const prompt = [{ role: 'user', content: 'Get weather' }]
    const params = { prompt }
    const model = {}

    it('should evaluate tool-call chunks with SDK.evaluate({ block: true })', async () => {
      aiguard.evaluate.resolves({ action: 'ALLOW', reason: '' })
      middleware = new AIGuardMiddleware({ tracer })

      const mockStream = createMockStream([
        { type: 'text-delta', textDelta: 'Checking...' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'getWeather',
          args: { city: 'Tokyo' }
        },
        { type: 'text-delta', textDelta: 'Done!' }
      ])

      const doStream = sinon.stub().resolves({
        stream: mockStream,
        response: { headers: {} }
      })

      const result = await middleware.wrapStream({ doStream, params, model })

      const chunks = await consumeStream(result.stream)

      // 2 calls: prompt + tool call
      assert.strictEqual(aiguard.evaluate.callCount, 2)
      assert.strictEqual(chunks.length, 3)
    })

    it('should insert error chunk when SDK throws AIGuardAbortError', async () => {
      aiguard.evaluate.onFirstCall().resolves({ action: 'ALLOW', reason: '' })
      aiguard.evaluate.onSecondCall().rejects(createSDKAbortError('Blocked tool', ['dangerous']))
      middleware = new AIGuardMiddleware({ tracer })

      const mockStream = createMockStream([
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'dangerousTool',
          args: {}
        },
        { type: 'text-delta', textDelta: 'Should not appear' }
      ])

      const doStream = sinon.stub().resolves({
        stream: mockStream,
        response: { headers: {} }
      })

      const result = await middleware.wrapStream({ doStream, params, model })

      const chunks = await consumeStream(result.stream)

      // Should have error chunk
      const errorChunk = chunks.find(c => c.type === 'error')
      assert.ok(errorChunk, 'Should have error chunk')
      assert.strictEqual(errorChunk.error.name, 'TripWire')
    })

    it('TripWire error should not expose sensitive fields (security)', async () => {
      aiguard.evaluate.onFirstCall().resolves({ action: 'ALLOW', reason: '' })
      aiguard.evaluate.onSecondCall().rejects(createSDKAbortError('Sensitive reason', ['secret']))
      middleware = new AIGuardMiddleware({ tracer })

      const mockStream = createMockStream([
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'dangerousTool',
          args: {}
        }
      ])

      const doStream = sinon.stub().resolves({
        stream: mockStream,
        response: { headers: {} }
      })

      const result = await middleware.wrapStream({ doStream, params, model })

      const chunks = await consumeStream(result.stream)

      const errorChunk = chunks.find(c => c.type === 'error')
      assert.ok(errorChunk)

      // Structural safety: sensitive fields must not exist
      assert.ok(!Object.prototype.hasOwnProperty.call(errorChunk.error, 'reason'))
      assert.ok(!Object.prototype.hasOwnProperty.call(errorChunk.error, 'tags'))
    })

    it('should allow normal chunks to pass through', async () => {
      aiguard.evaluate.resolves({ action: 'ALLOW', reason: '' })
      middleware = new AIGuardMiddleware({ tracer })

      const mockStream = createMockStream([
        { type: 'text-delta', textDelta: 'Hello' },
        { type: 'text-delta', textDelta: ' World' },
        { type: 'finish', finishReason: 'stop' }
      ])

      const doStream = sinon.stub().resolves({
        stream: mockStream,
        response: { headers: {} }
      })

      const result = await middleware.wrapStream({ doStream, params, model })

      const chunks = await consumeStream(result.stream)

      assert.strictEqual(chunks.length, 3)
      assert.strictEqual(chunks[0].type, 'text-delta')
      assert.strictEqual(chunks[1].type, 'text-delta')
      assert.strictEqual(chunks[2].type, 'finish')
    })

    it('should hard stop stream after tool call violation - no subsequent chunks pass through', async () => {
      aiguard.evaluate.onFirstCall().resolves({ action: 'ALLOW', reason: '' })
      aiguard.evaluate.onSecondCall().rejects(createSDKAbortError('Blocked tool', []))
      middleware = new AIGuardMiddleware({ tracer })

      const mockStream = createMockStream([
        // First: a violating tool-call
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'dangerousTool',
          args: {}
        },
        // Subsequent chunks that should NOT appear after hard stop
        { type: 'text-delta', textDelta: 'Should not appear 1' },
        { type: 'text-delta', textDelta: 'Should not appear 2' },
        {
          type: 'tool-call',
          toolCallId: 'call_2',
          toolName: 'anotherTool',
          args: {}
        }
      ])

      const doStream = sinon.stub().resolves({
        stream: mockStream,
        response: { headers: {} }
      })

      const result = await middleware.wrapStream({ doStream, params, model })

      const chunks = await consumeStream(result.stream)

      // Should have exactly 1 chunk: the error chunk
      assert.strictEqual(chunks.length, 1, 'Should have exactly 1 chunk (error only)')
      assert.strictEqual(chunks[0].type, 'error', 'The only chunk should be the error chunk')
      assert.strictEqual(chunks[0].error.name, 'TripWire')

      // Verify NO text-delta chunks passed through
      const textDeltas = chunks.filter(c => c.type === 'text-delta')
      assert.strictEqual(textDeltas.length, 0, 'No text-delta chunks should pass through after hard stop')

      // Verify NO subsequent tool-call chunks passed through
      const toolCalls = chunks.filter(c => c.type === 'tool-call')
      assert.strictEqual(toolCalls.length, 0, 'No tool-call chunks should pass through after hard stop')
    })
  })
})