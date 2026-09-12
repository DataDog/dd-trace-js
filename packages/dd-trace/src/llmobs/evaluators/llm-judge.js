'use strict'

const { validateEvaluatorName } = require('../experiments/util')
const { BaseEvaluator, EvaluatorResult } = require('./base')
const { isThenable } = require('./util')

const PLACEHOLDER_PATTERN = /\{\{(.+?)\}\}/g

// Context fields exposed to `{{...}}` prompt placeholders. Snake-case names match
// dd-trace-py and the backend prompt-template contract; camelCase aliases are
// accepted for convenience.
const CONTEXT_ALIASES = {
  inputData: 'input_data',
  outputData: 'output_data',
  expectedOutput: 'expected_output',
  spanId: 'span_id',
  traceId: 'trace_id',
}

const PUBLISH_PROVIDER_MAPPING = {
  openai: 'openai',
  anthropic: 'anthropic',
  azure_openai: 'azure_openai',
  vertexai: 'vertex_ai',
  bedrock: 'amazon_bedrock',
}

const DEFAULT_REASONING_DESCRIPTION = 'Explanation for the evaluation result'

/**
 * @typedef {{ role: 'system' | 'user', content: string }} LLMJudgeMessage
 */

/**
 * @typedef {(request: {
 *   provider: string | null,
 *   messages: LLMJudgeMessage[],
 *   jsonSchema: Record<string, unknown> | null,
 *   model: string,
 *   modelParams: Record<string, unknown> | null,
 * }) => string | Promise<string>} LLMJudgeModelCall
 */

class BaseStructuredOutput {
  /**
   * @param {object} [options]
   * @param {boolean} [options.reasoning] Ask the model for a `reasoning` field. Default `false`.
   * @param {string} [options.reasoningDescription] Schema description for the `reasoning` field.
   */
  constructor ({ reasoning = false, reasoningDescription } = {}) {
    this.reasoning = reasoning === true
    this.reasoningDescription = reasoningDescription ?? null
  }

  /** @type {string} */
  get label () {
    throw new Error('Subclasses must implement label')
  }

  /**
   * @param {Record<string, unknown>} labelSchema
   * @returns {Record<string, unknown>}
   */
  buildSchema (labelSchema) {
    const properties = { [this.label]: labelSchema }
    const required = [this.label]
    if (this.reasoning) {
      properties.reasoning = {
        type: 'string',
        description: this.reasoningDescription ?? DEFAULT_REASONING_DESCRIPTION,
      }
      required.push('reasoning')
    }
    return { type: 'object', properties, required, additionalProperties: false }
  }

  /** @type {() => Record<string, unknown>} */
  toJsonSchema () {
    throw new Error('Subclasses must implement toJsonSchema')
  }

  /** @returns {string} */
  get expectedType () {
    return 'value'
  }

  /**
   * @param {unknown} result
   * @returns {boolean}
   */
  validate (result) {
    return true
  }

  /**
   * @param {unknown} result
   * @returns {'pass' | 'fail' | null}
   */
  assess (result) {
    return null
  }

  /** @returns {Record<string, unknown> | null} */
  assessmentCriteria () {
    return null
  }
}

class BooleanStructuredOutput extends BaseStructuredOutput {
  /**
   * @param {object} options
   * @param {string} options.description
   * @param {boolean} [options.reasoning]
   * @param {string} [options.reasoningDescription]
   * @param {boolean} [options.passWhen] Value considered a pass.
   */
  constructor ({ description, reasoning, reasoningDescription, passWhen } = {}) {
    super({ reasoning, reasoningDescription })
    this.description = description
    this.passWhen = passWhen ?? null
  }

  get label () {
    return 'boolean_eval'
  }

  get expectedType () {
    return 'boolean'
  }

  validate (result) {
    return typeof result === 'boolean'
  }

  toJsonSchema () {
    return this.buildSchema({ type: 'boolean', description: this.description })
  }

  assess (result) {
    if (this.passWhen === null) return null
    return result === this.passWhen ? 'pass' : 'fail'
  }

  assessmentCriteria () {
    return this.passWhen === null ? null : { pass_when: this.passWhen }
  }
}

class ScoreStructuredOutput extends BaseStructuredOutput {
  /**
   * @param {object} options
   * @param {string} options.description
   * @param {number} options.minScore
   * @param {number} options.maxScore
   * @param {boolean} [options.reasoning]
   * @param {string} [options.reasoningDescription]
   * @param {number} [options.minThreshold] Lowest passing score.
   * @param {number} [options.maxThreshold] Highest passing score. When lower than `minThreshold`, scores outside
   *   the `(maxThreshold, minThreshold)` interval pass instead.
   */
  constructor ({ description, minScore, maxScore, reasoning, reasoningDescription, minThreshold, maxThreshold } = {}) {
    super({ reasoning, reasoningDescription })
    this.description = description
    this.minScore = minScore
    this.maxScore = maxScore
    this.minThreshold = minThreshold ?? null
    this.maxThreshold = maxThreshold ?? null
  }

  get label () {
    return 'score_eval'
  }

  get expectedType () {
    return 'number'
  }

  validate (result) {
    return typeof result === 'number'
  }

  toJsonSchema () {
    return this.buildSchema({
      type: 'number',
      description: this.description,
      minimum: this.minScore,
      maximum: this.maxScore,
    })
  }

  assess (result) {
    const minT = this.minThreshold
    const maxT = this.maxThreshold
    if (minT !== null && maxT !== null) {
      if (maxT >= minT) return result >= minT && result <= maxT ? 'pass' : 'fail'
      return result < maxT || result > minT ? 'pass' : 'fail'
    }
    if (minT !== null) return result >= minT ? 'pass' : 'fail'
    if (maxT !== null) return result <= maxT ? 'pass' : 'fail'
    return null
  }

  assessmentCriteria () {
    if (this.minThreshold === null && this.maxThreshold === null) return null
    const criteria = {}
    if (this.minThreshold !== null) criteria.min_threshold = this.minThreshold
    if (this.maxThreshold !== null) criteria.max_threshold = this.maxThreshold
    return criteria
  }
}

class CategoricalStructuredOutput extends BaseStructuredOutput {
  /**
   * @param {object} options
   * @param {Record<string, string>} options.categories Category value to description.
   * @param {boolean} [options.reasoning]
   * @param {string} [options.reasoningDescription]
   * @param {string[]} [options.passValues] Categories considered a pass.
   */
  constructor ({ categories, reasoning, reasoningDescription, passValues } = {}) {
    super({ reasoning, reasoningDescription })
    this.categories = categories ?? {}
    this.passValues = passValues ?? null
  }

  get label () {
    return 'categorical_eval'
  }

  get expectedType () {
    return 'string'
  }

  validate (result) {
    return typeof result === 'string'
  }

  toJsonSchema () {
    const anyOf = Object.entries(this.categories).map(([value, description]) => ({ const: value, description }))
    return this.buildSchema({ type: 'string', anyOf })
  }

  assess (result) {
    if (this.passValues === null) return null
    return this.passValues.includes(result) ? 'pass' : 'fail'
  }

  assessmentCriteria () {
    return this.passValues === null ? null : { pass_values: this.passValues }
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Evaluator that asks an LLM to grade the task output. The model is invoked through
 * a user-supplied `modelCall` so no provider SDK is required.
 */
class LLMJudge extends BaseEvaluator {
  #modelCall

  /**
   * @param {object} options
   * @param {string} options.userPrompt Prompt template; `{{input_data}}`, `{{output_data}}`,
   *   `{{expected_output}}`, `{{metadata.key}}` placeholders are rendered from the evaluator context.
   * @param {LLMJudgeModelCall} options.modelCall Function performing the LLM request and returning the text response.
   * @param {string} options.model Model identifier forwarded to `modelCall`.
   * @param {string} [options.systemPrompt]
   * @param {BaseStructuredOutput | Record<string, unknown>} [options.structuredOutput] Structured output
   *   definition or a raw JSON schema object.
   * @param {'openai' | 'anthropic' | 'azure_openai' | 'vertexai' | 'bedrock'} [options.provider] Provider name,
   *   forwarded to `modelCall` and required for `publishEvaluator`.
   * @param {Record<string, unknown>} [options.modelParams]
   * @param {string} [options.name]
   */
  constructor ({ userPrompt, modelCall, model, systemPrompt, structuredOutput, provider, modelParams, name } = {}) {
    super(name)
    if (typeof userPrompt !== 'string' || userPrompt.length === 0) {
      throw new Error('userPrompt must be a non-empty string')
    }
    if (typeof modelCall !== 'function') throw new TypeError('modelCall must be a callable function')
    if (provider != null && !Object.hasOwn(PUBLISH_PROVIDER_MAPPING, provider)) {
      const supported = JSON.stringify(Object.keys(PUBLISH_PROVIDER_MAPPING))
      throw new Error(`provider must be one of ${supported}, got: ${provider}`)
    }
    if (structuredOutput !== undefined && structuredOutput !== null &&
        !(structuredOutput instanceof BaseStructuredOutput) && !isPlainObject(structuredOutput)) {
      throw new TypeError('structuredOutput must be a structured output instance or a JSON schema object')
    }

    this.#modelCall = modelCall
    this.userPrompt = userPrompt
    this.systemPrompt = systemPrompt ?? null
    this.structuredOutput = structuredOutput ?? null
    this.provider = provider ?? null
    this.model = model ?? null
    this.modelParams = modelParams ?? null
  }

  /**
   * @param {import('./base').EvaluatorContext} context
   * @returns {string | EvaluatorResult | Promise<string | EvaluatorResult>}
   */
  evaluate (context) {
    const messages = []
    if (this.systemPrompt) messages.push({ role: 'system', content: this.systemPrompt })
    messages.push({ role: 'user', content: renderTemplate(this.userPrompt, context) })

    let jsonSchema = null
    if (this.structuredOutput !== null) {
      jsonSchema = this.structuredOutput instanceof BaseStructuredOutput
        ? this.structuredOutput.toJsonSchema()
        : this.structuredOutput
    }

    const response = this.#modelCall({
      provider: this.provider,
      messages,
      jsonSchema,
      model: this.model,
      modelParams: this.modelParams,
    })

    if (this.structuredOutput === null) return response
    if (isThenable(response)) return response.then(resolved => this.#parseResponse(resolved))
    return this.#parseResponse(response)
  }

  /**
   * @param {unknown} response
   * @returns {EvaluatorResult}
   */
  #parseResponse (response) {
    let data = response
    if (typeof response === 'string') {
      if (response.length === 0) throw new Error('Invalid response: expected non-empty string')
      try {
        data = JSON.parse(response)
      } catch (err) {
        throw new Error(`Invalid JSON response: ${err.message}`)
      }
    } else if (!isPlainObject(response)) {
      throw new Error('Invalid response: expected a JSON string or a plain object')
    }
    if (!isPlainObject(data)) throw new Error('Invalid JSON response: expected object')

    const structuredOutput = this.structuredOutput
    if (!(structuredOutput instanceof BaseStructuredOutput)) {
      return new EvaluatorResult(data, { reasoning: typeof data.reasoning === 'string' ? data.reasoning : null })
    }

    const result = data[structuredOutput.label]
    if (!structuredOutput.validate(result)) {
      throw new Error(`Expected ${structuredOutput.expectedType}, got ${result === null ? 'null' : typeof result}`)
    }
    const reasoning = structuredOutput.reasoning && typeof data.reasoning === 'string' ? data.reasoning : null
    return new EvaluatorResult(result, {
      reasoning,
      assessment: structuredOutput.assess(result),
      metadata: { raw_response: data },
    })
  }

  /**
   * Build the `evaluation` payload used by `experiments.publishEvaluator`.
   * @param {string} mlApp
   * @param {string} [evalName]
   * @param {Record<string, string>} [variableMapping] Renames prompt placeholders (`{{key}}` -> `{{value}}`).
   * @returns {Record<string, unknown>}
   */
  buildPublishPayload (mlApp, evalName, variableMapping) {
    if (typeof mlApp !== 'string' || mlApp.trim() === '') throw new Error('mlApp must be a non-empty string')
    const application = mlApp.trim()

    const resolvedEvalName = (evalName ?? this.name)
    if (typeof resolvedEvalName !== 'string' || resolvedEvalName.trim() === '') {
      throw new Error('evalName must be provided either as an option or as the evaluator name')
    }
    validateEvaluatorName(resolvedEvalName.trim())

    if (this.provider === null) throw new Error('provider must be specified to publish LLMJudge')
    const integrationProvider = PUBLISH_PROVIDER_MAPPING[this.provider]
    if (integrationProvider === undefined) {
      throw new Error(
        `Unsupported provider '${this.provider}' for publish(). Expected one of: ` +
        Object.keys(PUBLISH_PROVIDER_MAPPING).sort().join(', ')
      )
    }
    if (this.structuredOutput === null) throw new Error('structuredOutput must be provided to publish an evaluator')

    const mapping = normalizeVariableMapping(variableMapping)
    const byopConfig = {
      inference_params: this.modelParams ?? {},
      prompt_template: [
        { role: 'system', content: this.systemPrompt ?? '' },
        { role: 'user', content: applyVariableMapping(this.userPrompt, mapping) },
      ],
    }
    if (this.structuredOutput instanceof BaseStructuredOutput) {
      byopConfig.output_schema = formatSchemaForProvider(
        this.structuredOutput.toJsonSchema(), integrationProvider, this.structuredOutput.label
      )
      byopConfig.parsing_type = 'structured_output'
      const criteria = this.structuredOutput.assessmentCriteria()
      if (criteria !== null) byopConfig.assessment_criteria = criteria
    } else {
      byopConfig.output_schema = formatSchemaForProvider(this.structuredOutput, integrationProvider, 'evaluation')
      byopConfig.parsing_type = 'json'
    }

    const appPayload = {
      application_name: application,
      enabled: false,
      integration_provider: integrationProvider,
      model_provider: integrationProvider,
      byop_config: byopConfig,
    }
    const modelName = typeof this.model === 'string' ? this.model.trim() : ''
    if (modelName !== '') appPayload.model_name = modelName

    return { eval_name: resolvedEvalName.trim(), applications: [appPayload] }
  }
}

/**
 * @param {Record<string, unknown>} schema
 * @param {string} integrationProvider
 * @param {string} schemaName
 * @returns {Record<string, unknown>}
 */
function formatSchemaForProvider (schema, integrationProvider, schemaName) {
  if (integrationProvider === 'openai' || integrationProvider === 'azure_openai') {
    return { name: schemaName, strict: true, schema }
  }
  return schema
}

/**
 * @param {Record<string, string> | undefined} variableMapping
 * @returns {Record<string, string>}
 */
function normalizeVariableMapping (variableMapping) {
  if (variableMapping === undefined || variableMapping === null) return {}
  if (!isPlainObject(variableMapping)) throw new Error('variableMapping must be an object')
  const normalized = {}
  for (const [key, value] of Object.entries(variableMapping)) {
    if (key.trim() === '') throw new Error('variableMapping keys must be non-empty strings')
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('variableMapping values must be non-empty strings')
    }
    normalized[key.trim()] = value.trim()
  }
  return normalized
}

/**
 * @param {string} template
 * @param {Record<string, string>} mapping
 * @returns {string}
 */
function applyVariableMapping (template, mapping) {
  const keys = Object.keys(mapping)
  if (keys.length === 0) return template
  const escaped = keys.map(key => key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  const pattern = new RegExp(String.raw`\{\{\s*(${escaped.join('|')})\s*\}\}`, 'g')
  return template.replaceAll(pattern, (_, key) => `{{${mapping[key]}}}`)
}

/**
 * Render `{{path.to.field}}` placeholders from the evaluator context. Missing
 * values render as empty strings; objects and arrays are JSON-encoded.
 * @param {string} template
 * @param {import('./base').EvaluatorContext} context
 * @returns {string}
 */
function renderTemplate (template, context) {
  const root = {
    input_data: context.inputData,
    output_data: context.outputData,
    expected_output: context.expectedOutput,
    metadata: context.metadata,
    span_id: context.spanId,
    trace_id: context.traceId,
  }
  return template.replaceAll(PLACEHOLDER_PATTERN, (_, path) => {
    const parts = path.trim().split('.')
    const head = CONTEXT_ALIASES[parts[0]] ?? parts[0]
    let value = Object.hasOwn(root, head) ? root[head] : undefined
    for (let i = 1; i < parts.length; i++) {
      if (!isPlainObject(value)) return ''
      value = value[parts[i]]
    }
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') return JSON.stringify(value, null, 2)
    return String(value)
  })
}

module.exports = {
  BaseStructuredOutput,
  BooleanStructuredOutput,
  CategoricalStructuredOutput,
  LLMJudge,
  PUBLISH_PROVIDER_MAPPING,
  ScoreStructuredOutput,
  renderTemplate,
}
