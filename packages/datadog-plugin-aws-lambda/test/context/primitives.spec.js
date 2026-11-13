'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const { getStepFunctionContext, extractStepFunctionContext } = require('../../src/context/step-functions')
const { parseAWSTraceHeader, extractDatadogContext, extractXrayContext } = require('../../src/context/xray')
const { fromTraceContext } = require('../../src/context/span-context')

const legacy = require('../fixtures/legacy-step-function-event.json')

describe('Lambda Step Functions context', () => {
  for (const [name, traceId, high] of [
    ['legacy-step-function-event', '1139193989631387307', '1e3bc630afd0f64f'],
    ['legacy-lambda-root-step-function-event', '10593586103637578129', '0000000000001a4e'],
    ['lambda-root-step-function-event', '10593586103637578129', '0000000000001a4e'],
    ['nested-step-function-event', '8676990472248253142', '7ec140962b2ef025'],
  ]) {
    it(`preserves source IDs and context for ${name}`, () => {
      const event = require(`../fixtures/${name}.json`)
      const parsed = getStepFunctionContext(event)
      assert.strictEqual(parsed.execution_id, legacy.Execution.Id)
      assert.strictEqual(parsed.retry_count, '2')
      assert.strictEqual(parsed.redrive_count, '0')
      assert.strictEqual(parsed.state_name, 'step-one')
      assert.strictEqual(parsed.state_entered_time, '2022-12-08T21:08:19.224Z')
      const result = extractStepFunctionContext(parsed)
      assert.strictEqual(result.toTraceId(), traceId)
      assert.strictEqual(result.toSpanId(), '7747304477664363642')
      assert.strictEqual(result._sampling.priority, 1)
      // The propagated Lambda-root tag uses the source decimal radix, even when its input looks hex.
      assert.strictEqual(result._trace.tags['_dd.p.tid'], high)
    })
  }

  for (const event of [legacy, { Payload: legacy }, { _datadog: legacy }, { Payload: { _datadog: legacy } }]) {
    it('preserves the supported source envelopes', () => {
      const result = extractStepFunctionContext(getStepFunctionContext(event))
      assert.strictEqual(result.toTraceId(), '1139193989631387307')
      assert.strictEqual(result.toSpanId(), '7747304477664363642')
    })
  }

  for (const event of ['event', {}, { ...legacy, Execution: undefined },
    { ...legacy, Execution: { Id: 1 } }, { ...legacy, State: undefined },
    { ...legacy, State: { ...legacy.State, EnteredTime: 12345 } },
    { ...legacy, State: { ...legacy.State, Name: 1 } },
    { ...legacy, 'serverless-version': 'v1' }]) {
    it(`skips invalid source context: ${JSON.stringify(event)}`, () => {
      assert.strictEqual(getStepFunctionContext(event), undefined)
      assert.strictEqual(extractStepFunctionContext(getStepFunctionContext(event)), null)
    })
  }

  it('preserves source rejection of array-valued Lambda-root schema fields', () => {
    const event = {
      ...legacy,
      'serverless-version': 'v1',
      'x-datadog-trace-id': ['123'],
      'x-datadog-tags': ['_dd.p.tid=1'],
    }
    assert.strictEqual(getStepFunctionContext(event), undefined)
  })

  for (const event of [null, { _datadog: null }, { Payload: { _datadog: null } }]) {
    it('preserves source malformed-envelope errors for the invocation boundary to contain', () => {
      if (event === null) assert.throws(() => getStepFunctionContext(event), TypeError)
      else assert.strictEqual(getStepFunctionContext(event), undefined)
    })
  }

  it('uses retry and redrive counts in the parent ID but not the trace ID', () => {
    const results = []
    for (const [retry, redrive] of [[undefined, undefined], [0, 0], [1, 0], [0, 1], [1, 1]]) {
      const event = {
        ...legacy,
        Execution: { ...legacy.Execution, RedriveCount: redrive },
        State: { ...legacy.State, RetryCount: retry },
      }
      const result = extractStepFunctionContext(getStepFunctionContext(event))
      assert.strictEqual(result.toTraceId(), '1139193989631387307')
      results.push(result.toSpanId())
    }
    assert.strictEqual(results[0], results[1])
    assert.strictEqual(new Set(results).size, 4)
  })

  it('matches the source logs-backend parent hash vectors through parsed events', () => {
    for (const [executionId, enteredTime, expected] of [
      ['arn:aws:states:sa-east-1:425362996713:stateMachine:MyStateMachine-b276uka1j', '1', '3711631873188331089'],
      ['arn:aws:states:sa-east-1:425362996713:stateMachine:MyStateMachine-b276uka1j', '2', '5759173372325510050'],
    ]) {
      const event = { Execution: { Id: executionId }, State: { Name: 'lambda', EnteredTime: enteredTime } }
      assert.strictEqual(extractStepFunctionContext(getStepFunctionContext(event)).toSpanId(), expected)
    }
  })
})

describe('Lambda X-Ray context primitives', () => {
  const oldEnv = process.env
  afterEach(() => { process.env = oldEnv })

  it('parses the source AWS header', () => {
    assert.deepStrictEqual(parseAWSTraceHeader(
      'Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1'),
    { traceId: '1-5e272390-8c398be037738dc042009320', parentId: '94ae789b969f1cc5', sampled: '1' })
  })

  for (const header of ['Root=1-5e272390-8c398be037738dc042009320',
    'Root=1-65f2f78c-0000000008addb5405b376c0;Parent;Sampled', 'Root=1-5e272390-8c398be037738dc042009320;;']) {
    it(`rejects malformed header fields: ${header}`, () => {
      assert.strictEqual(parseAWSTraceHeader(header), undefined)
    })
  }

  for (const [trace, expected] of [
    ['1-5ce31dc2-2c779014b90ce44db5e03875', '4110911582297405557'],
    ['1-5ce31dc2-ac779014b90ce44db5e03875', '4110911582297405557'],
  ]) {
    for (const sampled of ['0', '1', '2', 'invalid']) {
      it(`converts ${trace} with sampled=${sampled}`, () => {
        process.env = { ...oldEnv, _X_AMZN_TRACE_ID: `Root=${trace};Parent=0b11cc4230d3e09e;Sampled=${sampled}` }
        const result = extractXrayContext()
        assert.strictEqual(result.toTraceId(), expected)
        assert.strictEqual(result.toSpanId(), '797643193680388254')
        assert.strictEqual(result._sampling.priority, sampled === '1' ? 2 : -1)
      })
    }
  }

  for (const header of [undefined, '',
    'Root=1-5ce31dc2-5e03875;Parent=0b11cc4230d3e09e;Sampled=1',
    'Root=1-2c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1',
    'Root=1-5ce31dc2-c779014b90ce44db5e03875;Parent=0b11cc4230d3e09e;Sampled=1',
    'Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=5e03875;Sampled=1',
    'Root=1-5ce31dc2-2c779014b90ce44db5e03875;Parent=gggggggggggggggg;Sampled=1']) {
    it(`returns no context for invalid X-Ray IDs: ${header}`, () => {
      process.env = { ...oldEnv }
      if (header === undefined) delete process.env._X_AMZN_TRACE_ID
      else process.env._X_AMZN_TRACE_ID = header
      assert.strictEqual(extractXrayContext(), null)
    })
  }

  it('extracts the source Java-injected Datadog context without using propagator settings', () => {
    const result = extractDatadogContext('Root=1-65f2f78c-0000000008addb5405b376c0;Parent=5abcb7ed643995c7;Sampled=1')
    assert.strictEqual(result.toTraceId(), '625397077193750208')
    assert.strictEqual(result.toSpanId(), '6538302989251745223')
    assert.strictEqual(result._sampling.priority, 1)
  })

  it('does not treat native X-Ray context as Java-injected Datadog context', () => {
    assert.strictEqual(extractDatadogContext(
      'Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1'), null)
  })
})

describe('Lambda custom span context conversion', () => {
  for (const value of [{ parentId: '1', sampleMode: 1 }, { traceId: '1', sampleMode: 1 }]) {
    it('requires both IDs', () => { assert.strictEqual(fromTraceContext(value), null) })
  }

  it('prefers current names over legacy names and retains the source empty-string fallback', () => {
    const context = fromTraceContext({ traceId: '', traceID: '123', parentId: '456', parentID: '789', sampleMode: 0 })
    assert.strictEqual(context.toTraceId(), '123')
    assert.strictEqual(context.toSpanId(), '456')
    assert.strictEqual(context._sampling.priority, 0)
  })
})
