'use strict'

const { BaseEvaluator, EvaluatorResult } = require('./evaluator')
const { hasEntries } = require('./util')

/**
 * @typedef {{value?: unknown, reasoning?: string, assessment?: string, status?: string}} RemoteEvaluatorResponse
 * @typedef {{evaluatorInfer: (evalName: string, context: object) => Promise<RemoteEvaluatorResponse>}}
 *   RemoteEvaluatorClient
 */

/**
 * @param {import('./evaluator').EvaluatorContext} context
 */
function defaultContextTransform (context) {
  const transformed = {
    span_input: context.inputData,
    span_output: context.outputData,
  }

  const meta = {}
  let hasMeta = false
  if (context.expectedOutput != null) {
    meta.expected_output = context.expectedOutput
    hasMeta = true
  }
  if (hasEntries(context.metadata)) {
    meta.metadata = context.metadata
    hasMeta = true
  }
  if (hasMeta) transformed.meta = meta

  if (context.spanId) transformed.span_id = context.spanId
  if (context.traceId) transformed.trace_id = context.traceId

  return transformed
}

class RemoteEvaluatorResult extends EvaluatorResult {
  /**
   * @param {unknown} value
   * @param {{reasoning?: string, assessment?: string, status?: string}} [options]
   */
  constructor (value, { reasoning, assessment, status } = {}) {
    super(value, { reasoning, assessment })
    this.status = status
    this.evalSourceType = 'managed'
  }
}

class RemoteEvaluatorError extends Error {
  /**
   * @param {string} message
   * @param {{status?: string, backendError?: object}} [options]
   */
  constructor (message, { status = 'ERROR', backendError = {} } = {}) {
    super(message)
    this.name = 'RemoteEvaluatorError'
    this.status = status
    this.backendError = backendError
  }
}

/**
 * Evaluator that references an LLM-as-a-judge evaluator configured in Datadog.
 */
class RemoteEvaluator extends BaseEvaluator {
  #evalName
  #transformFn

  /**
   * @param {{evalName: string, transformFn?: (context: import('./evaluator').EvaluatorContext) => object}} options
   */
  constructor (options) {
    super()
    const { evalName, transformFn } = options ?? {}
    if (typeof evalName !== 'string' || evalName.trim() === '') {
      throw new TypeError('evalName must be a non-empty string')
    }
    if (transformFn !== undefined && typeof transformFn !== 'function') {
      throw new TypeError('transformFn must be a function')
    }

    this.name = evalName.trim()
    this.#evalName = this.name
    this.#transformFn = transformFn ?? defaultContextTransform
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @param {RemoteEvaluatorClient} [client]
   */
  evaluate (context, client) {
    if (client === undefined || typeof client.evaluatorInfer !== 'function') {
      throw new Error('RemoteEvaluator can only be evaluated as part of an experiment')
    }

    const transformed = this.#transformFn(context)
    return client.evaluatorInfer(this.#evalName, transformed).then(result => new RemoteEvaluatorResult(
      result?.value,
      {
        reasoning: result?.reasoning,
        assessment: result?.assessment,
        status: result?.status,
      }
    ))
  }
}

module.exports = { RemoteEvaluator, RemoteEvaluatorError }
