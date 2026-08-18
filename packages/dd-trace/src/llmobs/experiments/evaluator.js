'use strict'

const { validateEvaluatorName } = require('./util')

/**
 * @param {object} evaluator
 * @param {string | undefined} name
 * @returns {string}
 */
function resolveEvaluatorName (evaluator, name) {
  const evaluatorName = name === undefined
    ? evaluator.constructor.name
    : typeof name === 'string' ? name.trim() : name
  validateEvaluatorName(evaluatorName)
  return evaluatorName
}

/**
 * Context passed to a record-level class evaluator.
 */
class EvaluatorContext {
  /**
   * @param {{inputData: unknown, outputData: unknown, expectedOutput?: unknown, metadata?: object,
   *   spanId?: string, traceId?: string}} options
   */
  constructor ({ inputData, outputData, expectedOutput, metadata = {}, spanId, traceId }) {
    this.inputData = inputData
    this.outputData = outputData
    this.expectedOutput = expectedOutput
    this.metadata = metadata
    this.spanId = spanId
    this.traceId = traceId
  }
}

/**
 * Context passed to a summary class evaluator.
 */
class SummaryEvaluatorContext {
  /**
   * @param {{inputs: unknown[], outputs: unknown[], expectedOutputs: unknown[], evaluationResults: object,
   *   metadata?: object[]}} options
   */
  constructor ({ inputs, outputs, expectedOutputs, evaluationResults, metadata = [] }) {
    this.inputs = inputs
    this.outputs = outputs
    this.expectedOutputs = expectedOutputs
    this.evaluationResults = evaluationResults
    this.metadata = metadata
  }
}

/**
 * A metric value with optional evaluation details.
 */
class EvaluatorResult {
  /**
   * @param {unknown | {value: unknown, reasoning?: string, assessment?: string, metadata?: object, tags?: object}}
   *   valueOrOptions
   * @param {{reasoning?: string, assessment?: string, metadata?: object, tags?: object}} [options]
   */
  constructor (valueOrOptions, options = {}) {
    const resultOptions = valueOrOptions !== null && typeof valueOrOptions === 'object' &&
      Object.hasOwn(valueOrOptions, 'value') && arguments.length === 1
      ? valueOrOptions
      : { value: valueOrOptions, ...options }

    this.value = resultOptions.value
    this.reasoning = resultOptions.reasoning
    this.assessment = resultOptions.assessment
    this.metadata = resultOptions.metadata
    this.tags = resultOptions.tags
  }
}

/**
 * A result that emits several named metrics from one evaluator invocation.
 */
class MultiEvaluatorResult {
  /**
   * @param {Record<string, unknown>} values
   * @param {boolean} [prefix]
   */
  constructor (values, prefix = true) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('MultiEvaluatorResult.values must be an object')
    }
    const keys = Object.keys(values)
    if (keys.length === 0) throw new Error('MultiEvaluatorResult.values must be a non-empty object')
    for (const key of keys) validateEvaluatorName(key)
    this.values = values
    this.prefix = prefix
  }
}

/**
 * Base class for reusable record-level evaluators.
 */
class BaseEvaluator {
  /**
   * @param {string} [name] Evaluator name. Defaults to the subclass name.
   */
  constructor (name) {
    this.name = resolveEvaluatorName(this, name)
  }

  /**
   * @param {EvaluatorContext} _context
   */
  evaluate (_context) {
    throw new Error('BaseEvaluator subclasses must implement evaluate(context)')
  }
}

/**
 * Base class for reusable summary evaluators.
 */
class BaseSummaryEvaluator {
  /**
   * @param {string} [name] Evaluator name. Defaults to the subclass name.
   */
  constructor (name) {
    this.name = resolveEvaluatorName(this, name)
  }

  /**
   * @param {SummaryEvaluatorContext} _context
   */
  evaluate (_context) {
    throw new Error('BaseSummaryEvaluator subclasses must implement evaluate(context)')
  }
}

module.exports = {
  BaseEvaluator,
  BaseSummaryEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  MultiEvaluatorResult,
  SummaryEvaluatorContext,
}
