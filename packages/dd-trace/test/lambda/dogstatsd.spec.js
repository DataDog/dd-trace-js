'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../plugins/agent')
const { HANDLER_STREAMING, STREAM_RESPONSE } =
  require('../../../datadog-instrumentations/src/helpers/lambda-handler')

describe('Lambda public DogStatsD completion', () => {
  let oldEnv, tracer, facade, context, flush, exporter
  let invocation = 0

  beforeEach(async () => {
    oldEnv = process.env
    process.env = {
      ...oldEnv,
      AWS_LAMBDA_FUNCTION_NAME: `dogstatsd-completion-${++invocation}`,
      DD_TRACE_ENABLED: 'true',
    }
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    delete process.env.DD_TRACE_DISABLED_PLUGINS
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    // This spec tests metric completion; keep trace exports from racing mock-agent teardown.
    exporter = sinon.stub(tracer._tracer._exporter, 'export')
    facade = require('../../src/lambda/facade')
    context = { functionName: 'dogstatsd-completion', getRemainingTimeInMillis: () => 5000 }
  })

  afterEach(async () => {
    exporter.restore()
    flush?.restore()
    flush = undefined
    process.env = oldEnv
    await agent.close()
  })

  for (const throws of [false, true]) {
    for (const flushThrows of [false, true]) {
      it(`flushes each invocation and preserves the result (handler throws=${throws}, flush throws=${flushThrows})`,
        async () => {
          flush = sinon.stub(tracer.dogstatsd, 'flush')
          if (flushThrows) flush.throws(new Error('flush failed'))
          const failure = new Error('customer failure')
          let calls = 0
          const handler = facade.wrap(() => {
            assert.strictEqual(flush.callCount, calls++)
            tracer.dogstatsd.distribution('completion.metric', 1)
            if (throws) throw failure
            return 'done'
          }, { enhancedMetrics: false })
          for (let invocation = 1; invocation <= 2; invocation++) {
            if (throws) await assert.rejects(handler({}, context), error => error === failure)
            else assert.strictEqual(await handler({}, context), 'done')
            assert.strictEqual(flush.callCount, invocation)
            assert.deepStrictEqual(flush.lastCall.args, [], 'best-effort flush has no delivery callback')
          }
        })
    }
  }

  for (const completion of ['callback', 'context', 'stream']) {
    it(`flushes after ${completion} completion`, async () => {
      flush = sinon.stub(tracer.dogstatsd, 'flush')
      let customer
      if (completion === 'callback') customer = (_event, _context, callback) => callback(null, 'done')
      else if (completion === 'context') customer = (_event, ctx) => { ctx.succeed('done') }
      else {
        customer = () => Promise.resolve('done')
        customer[HANDLER_STREAMING] = STREAM_RESPONSE
      }
      const handler = facade.wrap(customer)
      const args = completion === 'stream' ? [{}, {}, context] : [{}, context]
      assert.strictEqual(await handler(...args), 'done')
      sinon.assert.calledOnceWithExactly(flush)
    })
  }

  it('flushes independently of the Lambda tracing plugin', async () => {
    tracer.use('aws-lambda', { enabled: false })
    flush = sinon.stub(tracer.dogstatsd, 'flush')
    const handler = facade.wrap(() => 'done', { enhancedMetrics: false })
    assert.strictEqual(await handler({}, context), 'done')
    sinon.assert.calledOnceWithExactly(flush)
  })

  it('leaves an unused public client uninitialized', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(tracer, 'dogstatsd')
    assert.strictEqual(typeof descriptor.get, 'function')
    const handler = facade.wrap(() => 'done')
    assert.strictEqual(await handler({}, context), 'done')
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(tracer, 'dogstatsd'), descriptor)
  })
})
