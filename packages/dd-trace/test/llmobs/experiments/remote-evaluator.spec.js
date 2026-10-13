'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { EvaluatorContext, EvaluatorResult } = require('../../../src/llmobs/experiments/evaluator')
const {
  RemoteEvaluator,
  RemoteEvaluatorError,
} = require('../../../src/llmobs/experiments/remote-evaluator')

describe('LLMObs RemoteEvaluator', () => {
  it('validates its options', () => {
    // @ts-expect-error Testing runtime validation of missing options.
    assert.throws(() => new RemoteEvaluator(), /evalName must be a non-empty string/)
    assert.throws(() => new RemoteEvaluator({ evalName: '' }), /evalName must be a non-empty string/)
    assert.throws(
      // @ts-expect-error Testing runtime validation of a non-function transform.
      () => new RemoteEvaluator({ evalName: 'judge', transformFn: 'invalid' }),
      /transformFn must be a function/
    )
    assert.equal(new RemoteEvaluator({ evalName: '  managed-judge  ' }).name, 'managed-judge')
  })

  it('maps an evaluator context to the managed evaluator request shape', async () => {
    let request
    const client = {
      evaluatorInfer: (evalName, context) => {
        request = { evalName, context }
        return Promise.resolve({
          value: 0.95,
          reasoning: 'The answer is correct.',
          assessment: 'pass',
          status: 'OK',
        })
      },
    }
    const evaluator = new RemoteEvaluator({ evalName: 'managed-judge' })
    const context = new EvaluatorContext({
      inputData: { question: 'What is the capital of France?' },
      outputData: 'Paris',
      expectedOutput: 'Paris',
      metadata: { difficulty: 'easy' },
      spanId: 'span-id',
      traceId: 'trace-id',
    })

    const result = await evaluator.evaluate(context, client)

    assert.deepEqual(request, {
      evalName: 'managed-judge',
      context: {
        span_input: { question: 'What is the capital of France?' },
        span_output: 'Paris',
        meta: {
          expected_output: 'Paris',
          metadata: { difficulty: 'easy' },
        },
        span_id: 'span-id',
        trace_id: 'trace-id',
      },
    })
    assert.ok(result instanceof EvaluatorResult)
    assert.equal(result.value, 0.95)
    assert.equal(result.reasoning, 'The answer is correct.')
    assert.equal(result.assessment, 'pass')
    assert.equal(result.status, 'OK')
    assert.equal(result.evalSourceType, 'managed')
  })

  it('supports a custom context transform', async () => {
    let transformed
    const evaluator = new RemoteEvaluator({
      evalName: 'managed-judge',
      transformFn: context => ({
        prompt: /** @type {{prompt: string}} */ (context.inputData).prompt,
      }),
    })
    const client = {
      evaluatorInfer: (_evalName, context) => {
        transformed = context
        return Promise.resolve({ value: 'good' })
      },
    }

    const result = await evaluator.evaluate(new EvaluatorContext({
      inputData: { prompt: 'hello' },
      outputData: 'world',
    }), client)

    assert.deepEqual(transformed, { prompt: 'hello' })
    assert.equal(result.value, 'good')
  })

  it('requires the experiment client when evaluated', () => {
    const evaluator = new RemoteEvaluator({ evalName: 'managed-judge' })
    const context = new EvaluatorContext({ inputData: 'hello', outputData: 'world' })

    assert.throws(
      () => evaluator.evaluate(context),
      /RemoteEvaluator can only be evaluated as part of an experiment/
    )
  })

  it('preserves backend error details', () => {
    const error = new RemoteEvaluatorError('Managed evaluation failed', {
      status: 'WARN',
      backendError: {
        type: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded',
        recommended_resolution: 'Wait before retrying',
      },
    })

    assert.equal(error.name, 'RemoteEvaluatorError')
    assert.equal(error.status, 'WARN')
    assert.deepEqual(error.backendError, {
      type: 'RATE_LIMIT_EXCEEDED',
      message: 'Rate limit exceeded',
      recommended_resolution: 'Wait before retrying',
    })
  })
})
