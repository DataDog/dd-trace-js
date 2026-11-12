'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it } = require('mocha')

const lambda = require('../../../../lambda')

describe('Lambda facade', () => {
  it('keeps the cross-major public surface narrow', () => {
    assert.deepStrictEqual(Object.keys(lambda).sort(), [
      'getTraceHeaders',
      'reportInitFailure',
      'sendDistributionMetric',
      'sendDistributionMetricWithDate',
      'wrap',
    ])
  })

  it('activates the invocation plugin when the facade is imported before the Lambda environment is available', () => {
    const script = `
      const assert = require('node:assert/strict')
      delete process.env.AWS_LAMBDA_FUNCTION_NAME
      delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      delete process.env.DD_TRACE_DISABLED_PLUGINS
      delete process.env.DD_TRACE_AWS_LAMBDA_ENABLED
      const { wrap, getTraceHeaders } = require(${JSON.stringify(require.resolve('../../../../lambda'))})
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'early-facade-test'
      const tracer = require(${JSON.stringify(require.resolve('../../../..'))}).init({
        startupLogs: false,
        runtimeMetrics: false,
        remoteConfig: { enabled: false }
      })
      assert.strictEqual(tracer.scope().active(), null)
      const handler = wrap(() => {
        assert.ok(tracer.scope().active())
        assert.deepStrictEqual(Object.keys(getTraceHeaders()).sort(), [
          'x-datadog-parent-id', 'x-datadog-sampling-priority', 'x-datadog-trace-id'
        ])
        return 'done'
      })
      handler({}, {}).then(result => {
        assert.strictEqual(result, 'done')
        assert.strictEqual(tracer.scope().active(), null)
      }).catch(error => {
        console.error(error)
        process.exitCode = 1
      })
    `
    const result = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, DD_TRACE_ENABLED: 'true', DD_INJECT_FORCE: 'true' },
    })
    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('returns no trace headers outside an active invocation', () => {
    assert.deepStrictEqual(lambda.getTraceHeaders(), {})
  })

  it('fails loudly on the entry points that land with the metrics pipeline', () => {
    assert.throws(() => lambda.sendDistributionMetric('m', 1), /not implemented yet/)
    assert.throws(() => lambda.sendDistributionMetricWithDate('m', 1, new Date()), /not implemented yet/)
    assert.throws(
      () => lambda.reportInitFailure({ error: new Error('x'), functionName: 'f', startTime: 0 }),
      /not implemented yet/
    )
  })
})
