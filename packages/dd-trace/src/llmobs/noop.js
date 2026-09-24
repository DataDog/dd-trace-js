'use strict'

const NoopPrompts = require('./prompts/noop')
const evaluatorTypes = require('./experiments/evaluator')
const evaluatorBuiltins = {
  ...require('./experiments/llm-judge'),
  ...require('./experiments/builtins'),
}

let NoopExperiments

class NoopLLMObs {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  get enabled () {
    return false
  }

  get experiments () {
    NoopExperiments ??= require('./experiments/noop')
    return new NoopExperiments('LLM Observability is not enabled')
  }

  /**
   * Prompt Management API.
   * @returns {import('../../../../index').llmobs.Prompts}
   */
  get prompts () {
    return new NoopPrompts()
  }

  get BaseAsyncEvaluator () {
    return evaluatorTypes.BaseAsyncEvaluator
  }

  get BaseAsyncSummaryEvaluator () {
    return evaluatorTypes.BaseAsyncSummaryEvaluator
  }

  get BaseEvaluator () {
    return evaluatorTypes.BaseEvaluator
  }

  get BaseSummaryEvaluator () {
    return evaluatorTypes.BaseSummaryEvaluator
  }

  get EvaluatorContext () {
    return evaluatorTypes.EvaluatorContext
  }

  get SummaryEvaluatorContext () {
    return evaluatorTypes.SummaryEvaluatorContext
  }

  get EvaluatorResult () {
    return evaluatorTypes.EvaluatorResult
  }

  get MultiEvaluatorResult () {
    return evaluatorTypes.MultiEvaluatorResult
  }

  get BaseStructuredOutput () {
    return evaluatorBuiltins.BaseStructuredOutput
  }

  get BooleanStructuredOutput () {
    return evaluatorBuiltins.BooleanStructuredOutput
  }

  get CategoricalStructuredOutput () {
    return evaluatorBuiltins.CategoricalStructuredOutput
  }

  get LLMJudge () {
    return evaluatorBuiltins.LLMJudge
  }

  get ScoreStructuredOutput () {
    return evaluatorBuiltins.ScoreStructuredOutput
  }

  get JSONEvaluator () {
    return evaluatorBuiltins.JSONEvaluator
  }

  get LengthEvaluator () {
    return evaluatorBuiltins.LengthEvaluator
  }

  get RegexMatchEvaluator () {
    return evaluatorBuiltins.RegexMatchEvaluator
  }

  get SemanticSimilarityEvaluator () {
    return evaluatorBuiltins.SemanticSimilarityEvaluator
  }

  get StringCheckEvaluator () {
    return evaluatorBuiltins.StringCheckEvaluator
  }

  enable (options) {}

  disable () {}

  trace (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const name = options.name || options.kind || fn.name

    return this._tracer.trace(name, options, fn)
  }

  wrap (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const name = options.name || options.kind || fn.name

    return this._tracer.wrap(name, options, fn)
  }

  decorate (options = {}) {
    const llmobs = this
    return function (target, ctxOrPropertyKey, descriptor) {
      if (!ctxOrPropertyKey) return target
      if (typeof ctxOrPropertyKey === 'object') {
        const ctx = ctxOrPropertyKey
        if (ctx.kind !== 'method') return target

        return llmobs.wrap({ name: ctx.name, _decorator: true, ...options }, target)
      }
      const propertyKey = ctxOrPropertyKey
      if (descriptor) {
        if (typeof descriptor.value !== 'function') return descriptor

        const original = descriptor.value
        descriptor.value = llmobs.wrap({ name: propertyKey, _decorator: true, ...options }, original)

        return descriptor
      }
      if (typeof target[propertyKey] !== 'function') return target[propertyKey]

      const original = target[propertyKey]
      Object.defineProperty(target, propertyKey, {
        ...Object.getOwnPropertyDescriptor(target, propertyKey),
        value: llmobs.wrap({ name: propertyKey, _decorator: true, ...options }, original),
      })

      return target
    }
  }

  annotate (span, options) {}

  exportSpan (span) {
    return {}
  }

  submitEvaluation (llmobsSpanContext, options) {}

  submitFeedback (options) {}

  flush () {}

  registerProcessor (processor) {}

  deregisterProcessor () {}

  annotationContext (options, fn) { return fn() }

  routingContext (options, fn) { return fn() }
}

module.exports = NoopLLMObs
