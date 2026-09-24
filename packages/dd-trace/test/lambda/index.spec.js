'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { channel } = require('dc-polyfill')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../plugins/agent')
const Hook = require('../../src/ritm')

const oldEnv = process.env

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
  // The shared agent harness disables plugins globally; opt the Lambda lifecycle
  // back in so this suite exercises the same plugin that the Lambda bootstrap enables.
  return agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
}

async function closeAgent () {
  // `Hook.reset` clears RITM's per-module cache and registered hooks
  // so the next test re-evaluates `src/lambda`'s `registerLambdaHook`
  // against the new env and re-patches the freshly-loaded fixture.
  // Safe in `test:lambda` because no test in this process loads other
  // integrations.
  Hook.reset()
  delete require.cache[require.resolve('../../src/lambda')]
  delete require.cache[require.resolve('../../src/lambda/runtime/patch.js')]
  delete require.cache[require.resolve('./fixtures/handler')]
  delete require.cache[require.resolve('./fixtures/datadog-lambda')]
  await agent.close()
}

describe('lambda', () => {
  let datadog

  describe('patch', () => {
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

      const result = await datadog(app.handler)(_event, _context)
      assert.deepStrictEqual(JSON.parse(result.body), { message: 'hello!' })

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    it('patches lambda function with callback correctly', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.callbackHandler'
      await loadAgent()

      const _context = { getRemainingTimeInMillis: () => 150 }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      const result = await datadog(app.callbackHandler)(_event, _context, () => {})

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

      await assert.rejects(datadog(app.errorHandler)(_event, _context), { name: 'CustomError' })

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

      const result = await datadog(app.swappedArgsHandler)(_event, {}, _context)
      assert.deepStrictEqual(JSON.parse(result.body), { message: 'hello!' })

      await agent.assertSomeTraces(traces => {
        assert.strictEqual(traces[0].length, 1)
        for (const trace of traces[0]) {
          assert.strictEqual(trace.error, 0)
        }
      })
    })

    // AppSec invocation publishing lands with the AppSec port (migration PR 13); this pins only the
    // generic invocation boundary that the lifecycle owns.
    it('publishes exactly one generic invocation boundary for HTTP events', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      await loadAgent()

      const starts = []
      const ends = []
      const subscriptions = [
        [channel('datadog:aws-lambda:invocation:start'), message => starts.push(message)],
        [channel('datadog:aws-lambda:invocation:end'), message => ends.push(message)],
      ]
      for (const [invocationChannel, handler] of subscriptions) invocationChannel.subscribe(handler)

      try {
        const app = require(path.resolve(__dirname, './fixtures/handler.js'))
        datadog = require('./fixtures/datadog-lambda')
        const event = {
          body: JSON.stringify({ hello: 'world' }),
          headers: { 'Content-Type': 'application/json' },
          httpMethod: 'POST',
          path: '/resource',
          requestContext: { identity: { sourceIp: '127.0.0.1' } },
        }
        const context = { getRemainingTimeInMillis: () => 150 }

        await datadog(app.handler)(event, context)
        await agent.assertSomeTraces(() => {})

        assert.strictEqual(starts.length, 1)
        assert.strictEqual(ends.length, 1)
        assert.strictEqual(starts[0], ends[0])
        assert.strictEqual(starts[0].event, event)
        assert.strictEqual(starts[0].context, context)
      } finally {
        for (const [invocationChannel, handler] of subscriptions) invocationChannel.unsubscribe(handler)
      }
    })

    it('doesnt patch lambda when instrumentation is disabled', async () => {
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const handlerBefore = require(_handlerPath).handler

      process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'lambda'
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      await loadAgent()

      const handlerAfter = require(_handlerPath).handler
      assert.strictEqual(handlerBefore, handlerAfter)
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

      const result = await datadog(app.authorizerHandler)(_event)
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

      const result = await datadog(app.authorizerHandlerSync)(_event)
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

      await assert.rejects(
        datadog(app.authorizerErrorHandler)(_event),
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
      const result = datadog(app.finishSpansEarlyTimeoutHandler)(_event, _context)

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

        const result = datadog(app.timeoutHandler)(_event, _context)

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
