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
  delete process.env.DD_SERVICE_MAPPING
  delete process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED
  for (const [key, value] of Object.entries(extra || {})) process.env[key] = value
}

function invoke (config) {
  const { wrap } = require('../../../lambda')
  const context = {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    getRemainingTimeInMillis: () => 30_000,
  }
  const wrapped = wrap((_event, _context) => ({ statusCode: 200 }), config)
  return wrapped({}, context)
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

    describe('configured service overrides', () => {
      for (const { name, env, config = {}, handlerConfig, expected } of [
        {
          name: 'uses the aws-lambda service mapping',
          env: { DD_SERVICE_MAPPING: 'aws-lambda:mapped-lambda' },
          expected: 'mapped-lambda',
        },
        {
          name: 'uses the programmatic plugin service without normalization',
          config: { service: 'Configured-Service' },
          expected: 'Configured-Service',
        },
        {
          name: 'prefers the service mapping over DD_SERVICE',
          env: { DD_SERVICE_MAPPING: 'aws-lambda:mapped-lambda', DD_SERVICE: 'application-service' },
          expected: 'mapped-lambda',
        },
        {
          name: 'prefers the service mapping over the legacy representation',
          env: { DD_SERVICE_MAPPING: 'aws-lambda:mapped-lambda', DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED: 'false' },
          expected: 'mapped-lambda',
        },
        {
          name: 'prefers the plugin service over mapping, DD_SERVICE, and legacy representation',
          env: {
            DD_SERVICE_MAPPING: 'aws-lambda:mapped-lambda',
            DD_SERVICE: 'application-service',
            DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED: 'false',
          },
          config: { service: 'plugin-service' },
          expected: 'plugin-service',
        },
        {
          name: 'falls back to trimmed DD_SERVICE when the plugin service is empty',
          env: { DD_SERVICE: '  application-service  ' },
          config: { service: '' },
          expected: 'application-service',
        },
        {
          name: 'uses the per-handler service without normalization',
          handlerConfig: { service: 'Handler-Service' },
          expected: 'Handler-Service',
        },
        {
          name: 'prefers the per-handler service over DD_SERVICE',
          env: { DD_SERVICE: 'application-service' },
          handlerConfig: { service: 'handler-service' },
          expected: 'handler-service',
        },
        {
          name: 'prefers the per-handler service over plugin, mapping, and legacy defaults',
          env: {
            DD_SERVICE_MAPPING: 'aws-lambda:mapped-lambda',
            DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED: 'false',
          },
          config: { service: 'plugin-service' },
          handlerConfig: { service: 'handler-service' },
          expected: 'handler-service',
        },
        {
          name: 'inherits the plugin service when per-handler service is undefined',
          config: { service: 'plugin-service' },
          handlerConfig: { service: undefined, handlerCompletion: 'return' },
          expected: 'plugin-service',
        },
        {
          name: 'uses service defaults when per-handler service is explicitly empty',
          env: { DD_SERVICE: '  application-service  ' },
          config: { service: 'plugin-service' },
          handlerConfig: { service: '' },
          expected: 'application-service',
        },
        {
          name: 'uses the per-handler legacy service representation',
          handlerConfig: { serviceRepresentationEnabled: false },
          expected: 'aws.lambda',
        },
        {
          name: 'lets per-handler service representation override the global setting',
          env: { DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED: 'false' },
          handlerConfig: { serviceRepresentationEnabled: true },
          expected: 'MyMixedCase-Function',
        },
        {
          name: 'inherits service representation when its per-handler option is undefined',
          config: { serviceRepresentationEnabled: false },
          handlerConfig: { serviceRepresentationEnabled: undefined },
          expected: 'aws.lambda',
        },
        {
          name: 'keeps the raw function name when a different integration is mapped',
          env: { DD_SERVICE_MAPPING: 'http:mapped-http' },
          expected: 'MyMixedCase-Function',
        },
      ]) {
        it(name, async () => {
          lambdaEnv(env)
          await agent.load('aws-lambda', config, { experimental: { exporter: 'agent' } })
          const traces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(span.service, expected)
            assert.strictEqual(span.resource, 'MyMixedCase-Function')
          })

          await invoke(handlerConfig)
          await traces
        })
      }

      for (const { name, config, handlerConfig, baseline, overridden } of [
        {
          name: 'service',
          config: { service: 'plugin-service' },
          handlerConfig: { service: 'handler-service' },
          baseline: 'plugin-service',
          overridden: 'handler-service',
        },
        {
          name: 'service representation',
          config: { serviceRepresentationEnabled: false },
          handlerConfig: { serviceRepresentationEnabled: true },
          baseline: 'aws.lambda',
          overridden: 'MyMixedCase-Function',
        },
      ]) {
        it(`keeps ${name} overrides isolated between handlers`, async () => {
          lambdaEnv()
          await agent.load('aws-lambda', config, { experimental: { exporter: 'agent' } })
          Object.freeze(handlerConfig)
          for (const [options, expected] of [
            [undefined, baseline],
            [handlerConfig, overridden],
            [{}, baseline],
            [handlerConfig, overridden],
          ]) {
            const traces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, expected)
            })
            await invoke(options)
            await traces
          }
        })
      }
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
        const wrapped = wrapHandler(() => { throw new Error('handler exploded') })
        await assert.rejects(wrapped({}, context), { message: 'handler exploded' })
        await traces
      })
    })
  })
})
