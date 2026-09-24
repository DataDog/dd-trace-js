'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { wrapHandler } = require('../../datadog-instrumentations/src/aws-lambda')

const oldEnv = process.env

function lambdaEnv (extra) {
  process.env = {
    ...oldEnv,
    AWS_LAMBDA_FUNCTION_NAME: 'MyMixedCase-Function',
    DD_TRACE_ENABLED: 'true',
    ...extra,
  }
  delete process.env.DD_SERVICE
  delete process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED
  for (const [key, value] of Object.entries(extra || {})) process.env[key] = value
}

function invoke () {
  const context = {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    getRemainingTimeInMillis: () => 30_000,
  }
  return wrapHandler((_event, _context) => ({ statusCode: 200 }))({}, context)
}

describe('Plugin', () => {
  describe('aws-lambda', () => {
    afterEach(() => {
      process.env = oldEnv
      return agent.close({ ritmReset: false })
    })

    describe('invocation span', () => {
      beforeEach(() => {
        lambdaEnv()
        return agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
      })

      it('names and types the span like datadog-lambda-js', async () => {
        const traces = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.strictEqual(span.name, 'aws.lambda')
          assert.strictEqual(span.type, 'serverless')
          assert.strictEqual(span.resource, 'MyMixedCase-Function')
          assert.strictEqual(span.meta['span.kind'], 'server')
        })

        assert.deepStrictEqual(await invoke(), { statusCode: 200 })
        await traces
      })

      // The service-naming schema's `identityService` would hand back dd-trace's `Config.service`,
      // which in a Lambda is `normalizeService(AWS_LAMBDA_FUNCTION_NAME)` — lowercased. Customers
      // key dashboards off this value, so it has to stay the raw function name.
      it('uses the unnormalized function name as the service', async () => {
        const traces = agent.assertSomeTraces(traces => {
          assert.strictEqual(traces[0][0].service, 'MyMixedCase-Function')
        })

        await invoke()
        await traces
      })
    })

    describe('with DD_SERVICE set', () => {
      beforeEach(() => {
        lambdaEnv({ DD_SERVICE: '  spaced-service  ' })
        return agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
      })

      it('prefers a trimmed DD_SERVICE over the function name', async () => {
        const traces = agent.assertSomeTraces(traces => {
          assert.strictEqual(traces[0][0].service, 'spaced-service')
        })

        await invoke()
        await traces
      })
    })

    describe('with DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED=false', () => {
      beforeEach(() => {
        lambdaEnv({ DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED: 'false' })
        return agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
      })

      it('falls back to the legacy aws.lambda service representation', async () => {
        const traces = agent.assertSomeTraces(traces => {
          assert.strictEqual(traces[0][0].service, 'aws.lambda')
        })

        await invoke()
        await traces
      })
    })

    describe('error handling', () => {
      beforeEach(() => {
        lambdaEnv()
        return agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
      })

      it('tags a thrown error on the span and rethrows it', async () => {
        const traces = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.strictEqual(span.error, 1)
          assert.strictEqual(span.meta['error.message'], 'handler exploded')
          assert.strictEqual(span.meta['error.type'], 'Error')
        })

        const context = { functionName: 'MyMixedCase-Function', getRemainingTimeInMillis: () => 30_000 }
        await assert.rejects(
          wrapHandler(() => { throw new Error('handler exploded') })({}, context),
          { message: 'handler exploded' }
        )
        await traces
      })
    })
  })
})
