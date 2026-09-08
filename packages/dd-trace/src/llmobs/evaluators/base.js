'use strict'

const { validateEvaluatorName } = require('../experiments/util')

/**
 * @typedef {null | string | number | boolean | JSONType[] | { [key: string]: JSONType }} JSONType
 */

/**
 * Container for evaluator results carrying reasoning, assessment, metadata
 * and tags alongside the primary value. Mirrors dd-trace-py `EvaluatorResult`.
 */
class EvaluatorResult {
  /**
   * @param {JSONType} value Primary evaluation result (boolean, number, string, object, ...).
   * @param {object} [fields]
   * @param {string} [fields.reasoning] Explanation of why this result was produced.
   * @param {string} [fields.assessment] Categorical assessment such as `'pass'` or `'fail'`.
   * @param {Record<string, JSONType>} [fields.metadata] Additional metadata about the evaluation.
   * @param {Record<string, JSONType>} [fields.tags] Tags used to categorize the evaluation.
   */
  constructor (value, { reasoning, assessment, metadata, tags } = {}) {
    this.value = value
    this.reasoning = reasoning ?? null
    this.assessment = assessment ?? null
    this.metadata = metadata ?? null
    this.tags = tags ?? null
  }
}

/**
 * Read-only context handed to `evaluate()`. Mirrors dd-trace-py `EvaluatorContext`.
 */
class EvaluatorContext {
  /**
   * @param {object} fields
   * @param {JSONType} fields.inputData Input handed to the task.
   * @param {unknown} fields.outputData Output produced by the task.
   * @param {JSONType} [fields.expectedOutput] Expected output for comparison.
   * @param {Record<string, unknown>} [fields.metadata] Record metadata merged with the experiment config.
   * @param {string} [fields.spanId] Span id of the task execution.
   * @param {string} [fields.traceId] Trace id of the task execution.
   */
  constructor ({ inputData, outputData, expectedOutput, metadata, spanId, traceId }) {
    this.inputData = inputData
    this.outputData = outputData
    this.expectedOutput = expectedOutput ?? null
    this.metadata = metadata ?? {}
    this.spanId = spanId ?? null
    this.traceId = traceId ?? null
    Object.freeze(this)
  }
}

/**
 * Read-only context handed to summary evaluators. Mirrors dd-trace-py `SummaryEvaluatorContext`.
 */
class SummaryEvaluatorContext {
  /**
   * @param {object} fields
   * @param {JSONType[]} fields.inputs
   * @param {unknown[]} fields.outputs
   * @param {JSONType[]} fields.expectedOutputs
   * @param {Record<string, unknown[]>} fields.evaluationResults Row evaluator values keyed by evaluator name.
   * @param {Array<Record<string, unknown>>} [fields.metadata] Per-record metadata merged with the experiment config.
   */
  constructor ({ inputs, outputs, expectedOutputs, evaluationResults, metadata }) {
    this.inputs = inputs
    this.outputs = outputs
    this.expectedOutputs = expectedOutputs
    this.evaluationResults = evaluationResults
    this.metadata = metadata ?? []
    Object.freeze(this)
  }
}

/**
 * Base class for object-style evaluators. Subclasses implement `evaluate(context)`
 * and may return a plain JSON value or an `EvaluatorResult`.
 */
class BaseEvaluator {
  /**
   * @param {string} [name] Metric label; defaults to the class name.
   */
  constructor (name) {
    const resolved = name === undefined || name === null ? this.constructor.name : String(name).trim()
    validateEvaluatorName(resolved)
    this.name = resolved
  }

  /**
   * @type {(context: EvaluatorContext) => JSONType | EvaluatorResult | Promise<JSONType | EvaluatorResult>}
   */
  evaluate (context) {
    throw new Error('Subclasses must implement the evaluate method')
  }
}

/**
 * @param {unknown} fn
 * @param {string} name
 */
function assertOptionalFunction (fn, name) {
  if (fn !== undefined && fn !== null && typeof fn !== 'function') {
    throw new TypeError(`${name} must be a callable function`)
  }
}

/**
 * @param {boolean} passed
 * @returns {EvaluatorResult}
 */
function booleanResult (passed) {
  return new EvaluatorResult(passed, { assessment: passed ? 'pass' : 'fail' })
}

module.exports = {
  BaseEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  SummaryEvaluatorContext,
  assertOptionalFunction,
  booleanResult,
}
