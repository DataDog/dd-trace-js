'use strict'

const assert = require('node:assert/strict')
const { AsyncResource } = require('node:async_hooks')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../plugins/agent')
const Hook = require('../../src/ritm')

const oldEnv = process.env
const originalRunInAsyncScope = AsyncResource.prototype.runInAsyncScope

function setupEnv () {
  process.env = {
    ...oldEnv,
    LAMBDA_TASK_ROOT: './packages/dd-trace/test/lambda/fixtures',
    AWS_LAMBDA_FUNCTION_NAME: 'mock-function-name',
    DD_TRACE_ENABLED: 'true',
    DD_LOG_LEVEL: 'debug',
  }
}

function loadAgent () {
  require('../../src/lambda')
  return agent.load([], [], { experimental: { exporter: 'agent' } })
}

async function closeAgent () {
  // `Hook.reset` clears RITM's per-module cache and registered hooks
  // so the next test re-evaluates `src/lambda`'s `registerLambdaHook`
  // against the new env and re-patches the freshly-loaded fixture.
  // Safe in `test:lambda` because no test in this process loads other
  // integrations.
  Hook.reset()
  AsyncResource.prototype.runInAsyncScope = originalRunInAsyncScope
  delete require.cache[require.resolve('../../src/lambda')]
  delete require.cache[require.resolve('../../src/lambda/runtime/async-resource')]
  delete require.cache[require.resolve('../../src/lambda/runtime/patch.js')]
  delete require.cache[require.resolve('./fixtures/handler')]
  delete require.cache[require.resolve('./fixtures/datadog-lambda')]
  await agent.close()
}

describe('lambda', () => {
  let datadog

  describe('patch', () => {
    /** @param {string} handlerName */
    async function loadHandler (handlerName) {
      process.env.DD_LAMBDA_HANDLER = `handler.${handlerName}`
      await loadAgent()

      const context = { getRemainingTimeInMillis: () => 150 }
      const handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      return { context, wrappedHandler: datadog(app[handlerName]) }
    }

    beforeEach(setupEnv)

    afterEach(() => {
      process.env = oldEnv
      return closeAgent()
    })

    it('patches lambda function correctly', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      await loadAgent()

      const _context = { getRemainingTimeInMillis: () => 150 }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const wrappedHandler = datadog(app.handler)
      const result = await wrappedHandler(_event, _context)
      assert.deepStrictEqual(JSON.parse(result.body), { message: 'hello!' })

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    it('preserves the invocation span in an AsyncResource created before the invocation', async () => {
      const { context, wrappedHandler } = await loadHandler('asyncResourceHandler')
      const firstContext = await wrappedHandler({}, context)
      const secondContext = await wrappedHandler({}, context)

      assert.match(firstContext.trace_id, /^[\da-f]+$/)
      assert.match(firstContext.span_id, /^[\da-f]+$/)
      assert.match(secondContext.trace_id, /^[\da-f]+$/)
      assert.match(secondContext.span_id, /^[\da-f]+$/)
      assert.notStrictEqual(firstContext.trace_id, secondContext.trace_id)
      assert.notStrictEqual(firstContext.span_id, secondContext.span_id)
    })

    it('preserves context captured by an AsyncResource during the invocation', async () => {
      const { context, wrappedHandler } = await loadHandler('capturedAsyncResourceHandler')
      const result = await wrappedHandler({}, context)

      assert.strictEqual(result.capturedSpanId, result.invocationSpanId)
      assert.notStrictEqual(result.capturedSpanId, result.childSpanId)
    })

    it('preserves an explicitly cleared scope', async () => {
      const { context, wrappedHandler } = await loadHandler('clearedAsyncResourceHandler')
      const result = await wrappedHandler({}, context)

      assert.strictEqual(result, null)
    })

    it('patches lambda function with callback correctly', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.callbackHandler'
      await loadAgent()

      const _context = { getRemainingTimeInMillis: () => 150 }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      let result
      const wrappedHandler = datadog(app.callbackHandler)
      wrappedHandler(_event, _context, (_error, response) => {
        result = response
      })

      assert.deepStrictEqual(JSON.parse(result.body), { message: 'hello!' })

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    it('does wrap handler causing unhandled promise rejections', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      await loadAgent()

      const _context = { getRemainingTimeInMillis: () => 150 }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const wrappedHandler = datadog(app.errorHandler)
      await assert.rejects(wrappedHandler(_event, _context), { name: 'CustomError' })

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 1)
        }
      })
    })

    it('correctly patch handler where context is the third argument', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.swappedArgsHandler'
      await loadAgent()

      const _context = { getRemainingTimeInMillis: () => 150 }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const wrappedHandler = datadog(app.swappedArgsHandler)
      const result = await wrappedHandler(_event, {}, _context)
      assert.deepStrictEqual(JSON.parse(result.body), { message: 'hello!' })

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    it('doesnt patch lambda when instrumentation is disabled', async () => {
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const handlerBefore = require(_handlerPath).handler

      process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'lambda'
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      await loadAgent()

      const handlerAfter = require(_handlerPath).handler
      assert.strictEqual(handlerBefore, handlerAfter)
      assert.strictEqual(AsyncResource.prototype.runInAsyncScope, originalRunInAsyncScope)
    })
  })

  describe('lambda authorizers (no context)', () => {
    beforeEach(setupEnv)

    afterEach(() => {
      process.env = oldEnv
      return closeAgent()
    })

    it('patches async lambda authorizer correctly (event only, no context)', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.authorizerHandler'
      await loadAgent()

      const _event = {
        type: 'REQUEST',
        methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/stage/GET/resource',
        headers: { Authorization: 'Bearer token123' },
      }

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const wrappedHandler = datadog(app.authorizerHandler)
      const result = await wrappedHandler(_event)
      assert.strictEqual(result.principalId, 'user123')
      assert.strictEqual(result.policyDocument.Statement[0].Effect, 'Allow')

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    it('patches sync lambda authorizer correctly (event only, no context)', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.authorizerHandlerSync'
      await loadAgent()

      const _event = {
        type: 'REQUEST',
        methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/stage/GET/resource',
      }

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const wrappedHandler = datadog(app.authorizerHandlerSync)
      const result = await wrappedHandler(_event)
      assert.strictEqual(result.principalId, 'user123')
      assert.strictEqual(result.policyDocument.Statement[0].Effect, 'Allow')

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    it('handles errors in lambda authorizer correctly (event only, no context)', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.authorizerErrorHandler'
      await loadAgent()

      const _event = {
        type: 'REQUEST',
        methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/stage/GET/resource',
      }

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const wrappedHandler = datadog(app.authorizerErrorHandler)
      await assert.rejects(
        wrappedHandler(_event),
        { name: 'AuthorizationError', message: 'Unauthorized' }
      )

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 1)
        }
      })
    })
  })

  describe('timeout spans', () => {
    beforeEach(setupEnv)

    afterEach(() => {
      process.env = oldEnv
      return closeAgent()
    })

    it('doesnt crash when spans are finished early and reached impending timeout', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.finishSpansEarlyTimeoutHandler'
      await loadAgent()

      const _context = { getRemainingTimeInMillis: () => 25 }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      const wrappedHandler = datadog(app.finishSpansEarlyTimeoutHandler)
      const result = wrappedHandler(_event, _context)

      const checkTraces = agent.assertSomeTraces(traces => {
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
      // `Promise.all` so a `checkTraces` rejection between `result`
      // settling and its own `await` doesn't surface as an unhandled
      // rejection.
      await Promise.all([result, checkTraces])
    })

    const deadlines = [
      { envVar: 'default' },
      { envVar: 'DD_APM_FLUSH_DEADLINE_MILLISECONDS', value: '-100' }, // clamps to 100
      { envVar: 'DD_APM_FLUSH_DEADLINE_MILLISECONDS', value: '10' },
    ]

    deadlines.forEach(deadline => {
      const flushDeadlineEnvVar = deadline.envVar
      const customDeadline = deadline.value ?? ''

      it(`traces error on impending timeout using ${flushDeadlineEnvVar} ${customDeadline} deadline`, async () => {
        process.env[flushDeadlineEnvVar] = customDeadline
        process.env.DD_LAMBDA_HANDLER = 'handler.timeoutHandler'

        const _context = { getRemainingTimeInMillis: () => 25 }
        const _event = {}

        const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')

        await loadAgent()
        const app = require(_handlerPath)
        datadog = require('./fixtures/datadog-lambda')

        const wrappedHandler = datadog(app.timeoutHandler)
        const result = wrappedHandler(_event, _context)

        const checkTraces = agent.assertSomeTraces(traces => {
          const trace = traces[0][0]
          assert.strictEqual(trace.error, 1)
          assert.strictEqual(trace.meta['error.type'], 'Impending Timeout')
        })
        await Promise.all([result, checkTraces])
      })
    })
  })
})
