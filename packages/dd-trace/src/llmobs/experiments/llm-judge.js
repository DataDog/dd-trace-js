'use strict'

const { getEnvironmentVariable } = require('../../config/helper')
const { BaseEvaluator, EvaluatorResult } = require('./evaluator')

const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'azure_openai', 'vertexai', 'bedrock']
const PROMPT_VARIABLE_PATTERN = /\{\{([^{}]*)\}\}/g

/**
 * @param {Array<{role: string, content: string}>} messages
 */
function systemMessage (messages) {
  let system = ''
  for (const message of messages) {
    if (message.role !== 'system') continue
    if (system.length > 0) system += '\n'
    system += message.content
  }
  return system
}

/**
 * @param {Record<string, unknown>} request
 * @param {string} key
 * @param {unknown} value
 */
function setRequestProperty (request, key, value) {
  request[key] = value
}

function valuesOrEmpty (options) {
  if (options == null) return {}
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Options must be an object')
  }
  return options
}

function option (options, camelName, snakeName) {
  return options[camelName] ?? options[snakeName]
}

function cloneSchema (schema) {
  return structuredClone(schema)
}

function buildStructuredSchema (structuredOutput, labelSchema) {
  const properties = { [structuredOutput.label]: labelSchema }
  const required = [structuredOutput.label]
  if (structuredOutput.reasoning) {
    properties.reasoning = {
      type: 'string',
      description: structuredOutput.reasoningDescription || 'Explanation for the evaluation result',
    }
    required.push('reasoning')
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * Base class for structured LLM judge output specifications.
 */
class BaseStructuredOutput {
  /**
   * @throws {Error} when called on the base class
   */
  get label () {
    throw new Error('Structured output subclasses must define a label')
  }

  /**
   * @throws {Error} when called on the base class
   */
  toJsonSchema () {
    throw new Error('Structured output subclasses must implement toJsonSchema()')
  }

  /**
   * @returns {object}
   */
  toJSONSchema () {
    return this.toJsonSchema()
  }
}

/**
 * Structured output specification for boolean LLM judge results.
 */
class BooleanStructuredOutput extends BaseStructuredOutput {
  /**
   * @param {string | {description: string, reasoning?: boolean, reasoningDescription?: string,
   *   passWhen?: boolean}} descriptionOrOptions
   * @param {{reasoning?: boolean, reasoningDescription?: string, passWhen?: boolean}} [options]
   */
  constructor (descriptionOrOptions, options = {}) {
    super()
    const values = typeof descriptionOrOptions === 'string'
      ? { ...options, description: descriptionOrOptions }
      : valuesOrEmpty(descriptionOrOptions)
    if (typeof values.description !== 'string' || values.description.length === 0) {
      throw new TypeError('description must be a non-empty string')
    }
    this.description = values.description
    this.reasoning = values.reasoning ?? false
    this.reasoningDescription = values.reasoningDescription ?? values.reasoning_description
    this.passWhen = values.passWhen ?? values.pass_when
  }

  /**
   * @returns {object}
   */
  get label () {
    return 'boolean_eval'
  }

  /**
   * @returns {object}
   */
  toJsonSchema () {
    return buildStructuredSchema(this, { type: 'boolean', description: this.description })
  }
}

/**
 * Structured output specification for numeric LLM judge results.
 */
class ScoreStructuredOutput extends BaseStructuredOutput {
  /**
   * @param {string | {description: string, minScore: number, maxScore: number, reasoning?: boolean,
   *   reasoningDescription?: string, minThreshold?: number, maxThreshold?: number}} [descriptionOrOptions]
   * @param {{minScore?: number, maxScore?: number, reasoning?: boolean, reasoningDescription?: string,
   *   minThreshold?: number, maxThreshold?: number}} [options]
   */
  constructor (descriptionOrOptions, options = {}) {
    super()
    const values = typeof descriptionOrOptions === 'string'
      ? { ...options, description: descriptionOrOptions }
      : valuesOrEmpty(descriptionOrOptions)
    if (typeof values.description !== 'string' || values.description.length === 0) {
      throw new TypeError('description must be a non-empty string')
    }
    const minScore = option(values, 'minScore', 'min_score')
    const maxScore = option(values, 'maxScore', 'max_score')
    if (typeof minScore !== 'number' || typeof maxScore !== 'number') {
      throw new TypeError('minScore and maxScore must be numbers')
    }
    if (minScore > maxScore) throw new Error('minScore cannot be greater than maxScore')

    this.description = values.description
    this.minScore = minScore
    this.maxScore = maxScore
    this.reasoning = values.reasoning ?? false
    this.reasoningDescription = values.reasoningDescription ?? values.reasoning_description
    this.minThreshold = option(values, 'minThreshold', 'min_threshold')
    this.maxThreshold = option(values, 'maxThreshold', 'max_threshold')
  }

  /**
   * @returns {object}
   */
  get label () {
    return 'score_eval'
  }

  /**
   * @returns {object}
   */
  toJsonSchema () {
    return buildStructuredSchema(this, {
      type: 'number',
      description: this.description,
      minimum: this.minScore,
      maximum: this.maxScore,
    })
  }
}

/**
 * Structured output specification for categorical LLM judge results.
 */
class CategoricalStructuredOutput extends BaseStructuredOutput {
  /**
   * @param {{categories: Record<string, string>, reasoning?: boolean, reasoningDescription?: string,
   *   passValues?: string[]}} options
   */
  constructor (options) {
    super()
    const values = valuesOrEmpty(options)
    if (values.categories === null || typeof values.categories !== 'object' || Array.isArray(values.categories)) {
      throw new TypeError('categories must be an object')
    }
    this.categories = values.categories
    this.reasoning = values.reasoning ?? false
    this.reasoningDescription = values.reasoningDescription ?? values.reasoning_description
    this.passValues = values.passValues ?? values.pass_values
  }

  /**
   * @returns {object}
   */
  get label () {
    return 'categorical_eval'
  }

  /**
   * @returns {object}
   */
  toJsonSchema () {
    const anyOf = Object.entries(this.categories).map(([value, description]) => ({ const: value, description }))
    return buildStructuredSchema(this, { type: 'string', anyOf })
  }
}

function loadDependency (name, installMessage) {
  try {
    return require(name)
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND' && error.message.includes(`'${name}'`)) {
      throw new Error(installMessage)
    }
    throw error
  }
}

function clientOption (options, camelName, snakeName, environmentName) {
  return option(options, camelName, snakeName) ?? getEnvironmentVariable(environmentName)
}

function openAIRequest (client, messages, schema, model, modelParams) {
  const request = { model, messages, ...modelParams }
  if (schema) {
    request.response_format = {
      type: 'json_schema',
      json_schema: { name: 'evaluation', strict: true, schema },
    }
  }
  return client.chat.completions.create(request).then(response => {
    return response.choices?.[0]?.message?.content ?? ''
  })
}

function createOpenAIClient (options) {
  const module = loadDependency('openai', 'openai package required: npm install openai')
  const OpenAI = module.OpenAI || module.default || module
  const apiKey = clientOption(options, 'apiKey', 'api_key', 'OPENAI_API_KEY')
  if (!apiKey) {
    throw new Error('OpenAI API key not provided. Pass apiKey in clientOptions or set OPENAI_API_KEY')
  }
  const clientOptions = { ...options }
  delete clientOptions.apiKey
  delete clientOptions.api_key
  if (clientOptions.base_url !== undefined && clientOptions.baseURL === undefined) {
    clientOptions.baseURL = clientOptions.base_url
    delete clientOptions.base_url
  }
  const client = new OpenAI({ apiKey, ...clientOptions })
  return (_provider, messages, schema, model, modelParams = {}) => {
    return openAIRequest(client, messages, schema, model, modelParams)
  }
}

function createAzureOpenAIClient (options) {
  const module = loadDependency('openai', 'openai package required: npm install openai')
  const AzureOpenAI = module.AzureOpenAI || module.default?.AzureOpenAI
  if (!AzureOpenAI) throw new Error('The installed openai package does not support AzureOpenAI')
  const apiKey = clientOption(options, 'apiKey', 'api_key', 'AZURE_OPENAI_API_KEY')
  const endpoint = clientOption(options, 'azureEndpoint', 'azure_endpoint', 'AZURE_OPENAI_ENDPOINT')
  const apiVersion = clientOption(options, 'apiVersion', 'api_version', 'AZURE_OPENAI_API_VERSION') || '2024-10-21'
  if (!apiKey) {
    throw new Error('Azure OpenAI API key not provided. Pass apiKey in clientOptions or set AZURE_OPENAI_API_KEY')
  }
  if (!endpoint) {
    throw new Error(
      'Azure OpenAI endpoint not provided. Pass azureEndpoint in clientOptions or set AZURE_OPENAI_ENDPOINT'
    )
  }
  const deployment = clientOption(options, 'azureDeployment', 'azure_deployment', 'AZURE_OPENAI_DEPLOYMENT')
  const known = ['apiKey', 'api_key', 'azureEndpoint', 'azure_endpoint', 'apiVersion', 'api_version',
    'azureDeployment', 'azure_deployment']
  const clientOptions = { ...options }
  for (const key of known) delete clientOptions[key]
  const client = new AzureOpenAI({ apiKey, endpoint, apiVersion, ...clientOptions })
  return (_provider, messages, schema, model, modelParams = {}) => {
    return openAIRequest(client, messages, schema, deployment || model, modelParams)
  }
}

function schemaForAnthropic (schema) {
  const result = cloneSchema(schema)
  const properties = result.properties
  if (!properties) return result
  for (const property of Object.values(properties)) {
    if (property.type === 'number') {
      const minimum = property.minimum
      const maximum = property.maximum
      delete property.minimum
      delete property.maximum
      if (minimum !== undefined || maximum !== undefined) {
        property.description = `${property.description ?? ''} (range: ${minimum} to ${maximum})`
      }
    }
    if (property.anyOf) delete property.type
  }
  return result
}

function createAnthropicClient (options) {
  const module = loadDependency('@anthropic-ai/sdk',
    '@anthropic-ai/sdk package required: npm install @anthropic-ai/sdk')
  const Anthropic = module.Anthropic || module.default || module
  const apiKey = clientOption(options, 'apiKey', 'api_key', 'ANTHROPIC_API_KEY')
  if (!apiKey) {
    throw new Error('Anthropic API key not provided. Pass apiKey in clientOptions or set ANTHROPIC_API_KEY')
  }
  const clientOptions = { ...options }
  delete clientOptions.apiKey
  delete clientOptions.api_key
  const client = new Anthropic({ apiKey, ...clientOptions })
  return async (_provider, messages, schema, model, modelParams = {}) => {
    const system = systemMessage(messages)
    const userMessages = messages.filter(message => message.role !== 'system')
    const request = { model, max_tokens: 4096, messages: userMessages, ...modelParams }
    if (system) setRequestProperty(request, 'system', system)
    if (schema) {
      setRequestProperty(request, 'extra_headers', { 'anthropic-beta': 'structured-outputs-2025-11-13' })
      setRequestProperty(request, 'extra_body', {
        output_format: { type: 'json_schema', schema: schemaForAnthropic(schema) },
      })
    }
    const response = await client.messages.create(request)
    const block = response.content?.[0]
    if (typeof block?.text === 'string') return block.text
    if (block?.json !== undefined) return JSON.stringify(block.json)
    return ''
  }
}

function schemaForVertex (schema) {
  const result = cloneSchema(schema)
  const properties = result.properties
  if (!properties) return result
  for (const property of Object.values(properties)) {
    if (!property.anyOf) continue
    const enumValues = property.anyOf.filter(item => Object.hasOwn(item, 'const')).map(item => item.const)
    if (enumValues.length > 0) {
      delete property.anyOf
      delete property.type
      property.enum = enumValues
    }
  }
  return result
}

function createVertexClient (options) {
  const module = loadDependency('@google-cloud/vertexai',
    '@google-cloud/vertexai package required: npm install @google-cloud/vertexai')
  const VertexAI = module.VertexAI || module.default?.VertexAI
  if (!VertexAI) throw new Error('The installed @google-cloud/vertexai package does not support VertexAI')
  const project = clientOption(options, 'project', 'project', 'GOOGLE_CLOUD_PROJECT') ||
    getEnvironmentVariable('GCLOUD_PROJECT')
  const location = clientOption(options, 'location', 'location', 'GOOGLE_CLOUD_LOCATION') ||
    getEnvironmentVariable('GOOGLE_CLOUD_REGION') || 'us-central1'
  if (!project) {
    throw new Error('Google Cloud project not provided. Pass project in clientOptions or set GOOGLE_CLOUD_PROJECT')
  }
  const vertexOptions = { project, location }
  if (options.credentials) vertexOptions.googleAuthOptions = { credentials: options.credentials }
  const vertex = new VertexAI(vertexOptions)
  return async (_provider, messages, schema, model, modelParams = {}) => {
    const system = systemMessage(messages)
    const contents = messages.filter(message => message.role !== 'system').map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }))
    const generationConfig = { ...modelParams }
    if (generationConfig.max_tokens !== undefined) {
      generationConfig.maxOutputTokens = generationConfig.max_tokens
      delete generationConfig.max_tokens
    }
    if (schema) {
      generationConfig.responseMimeType = 'application/json'
      generationConfig.responseSchema = schemaForVertex(schema)
    }
    const modelOptions = { model }
    if (system) modelOptions.systemInstruction = { parts: [{ text: system }] }
    const generativeModel = vertex.getGenerativeModel(modelOptions)
    const response = await generativeModel.generateContent({ contents, generationConfig })
    return response.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }
}

function createBedrockClient (options) {
  const module = loadDependency('@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-bedrock-runtime package required: npm install @aws-sdk/client-bedrock-runtime')
  const BedrockRuntimeClient = module.BedrockRuntimeClient
  const ConverseCommand = module.ConverseCommand
  if (!BedrockRuntimeClient || !ConverseCommand) {
    throw new Error('The installed @aws-sdk/client-bedrock-runtime package does not support ConverseCommand')
  }
  const clientOptions = { ...options }
  if (clientOptions.region_name !== undefined && clientOptions.region === undefined) {
    clientOptions.region = clientOptions.region_name
    delete clientOptions.region_name
  }
  if (clientOptions.profile_name !== undefined) delete clientOptions.profile_name
  clientOptions.region ||= getEnvironmentVariable('AWS_REGION') ||
    getEnvironmentVariable('AWS_DEFAULT_REGION') || 'us-east-1'
  const client = new BedrockRuntimeClient(clientOptions)
  return async (_provider, messages, schema, model, modelParams = {}) => {
    const system = messages.filter(message => message.role === 'system').map(message => ({ text: message.content }))
    const converseMessages = messages.filter(message => message.role !== 'system').map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ text: message.content }],
    }))
    const input = { modelId: model, messages: converseMessages }
    if (system.length > 0) input.system = system
    const inferenceConfig = {}
    let hasInferenceConfig = false
    const parameterNames = {
      temperature: 'temperature',
      topP: 'topP',
      top_p: 'topP',
      maxTokens: 'maxTokens',
      max_tokens: 'maxTokens',
      stopSequences: 'stopSequences',
      stop_sequences: 'stopSequences',
    }
    for (const [key, value] of Object.entries(modelParams)) {
      if (!parameterNames[key]) continue
      inferenceConfig[parameterNames[key]] = value
      hasInferenceConfig = true
    }
    if (hasInferenceConfig) input.inferenceConfig = inferenceConfig
    if (schema) {
      input.outputConfig = {
        textFormat: {
          type: 'json_schema',
          structure: {
            jsonSchema: { name: 'evaluation', schema: JSON.stringify(schemaForAnthropic(schema)) },
          },
        },
      }
    }
    const response = await client.send(new ConverseCommand(input))
    return response.output?.message?.content?.find(block => typeof block.text === 'string')?.text ?? ''
  }
}

function createProviderClient (provider, options) {
  if (provider === 'openai') return createOpenAIClient(options)
  if (provider === 'azure_openai') return createAzureOpenAIClient(options)
  if (provider === 'anthropic') return createAnthropicClient(options)
  if (provider === 'vertexai') return createVertexClient(options)
  if (provider === 'bedrock') return createBedrockClient(options)
  throw new Error(`Unsupported LLM provider '${provider}'. Expected one of ${SUPPORTED_PROVIDERS.join(', ')}`)
}

function resolveContextValue (context, path) {
  const aliases = { input_data: 'inputData', output_data: 'outputData', expected_output: 'expectedOutput' }
  const parts = path.split('.')
  let value = context[aliases[parts[0]] ?? parts[0]]
  for (let i = 1; i < parts.length; i++) {
    if (value === null || typeof value !== 'object') return
    value = value[parts[i]]
  }
  return value
}

function renderPrompt (template, context) {
  return template.replaceAll(PROMPT_VARIABLE_PATTERN, (_match, path) => {
    const value = resolveContextValue(context, path.trim())
    if (value == null) return ''
    if (typeof value === 'object') return JSON.stringify(value, null, 2)
    return String(value)
  })
}

function isPromiseLike (value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function'
}

function computeAssessment (structuredOutput, value) {
  if (structuredOutput instanceof BooleanStructuredOutput && structuredOutput.passWhen !== undefined) {
    return value === structuredOutput.passWhen ? 'pass' : 'fail'
  }
  if (structuredOutput instanceof CategoricalStructuredOutput && structuredOutput.passValues !== undefined) {
    return structuredOutput.passValues.includes(value) ? 'pass' : 'fail'
  }
  if (structuredOutput instanceof ScoreStructuredOutput) {
    const min = structuredOutput.minThreshold
    const max = structuredOutput.maxThreshold
    if (min !== undefined && max !== undefined) {
      if (max >= min) return value >= min && value <= max ? 'pass' : 'fail'
      return value < max || value > min ? 'pass' : 'fail'
    }
    if (min !== undefined) return value >= min ? 'pass' : 'fail'
    if (max !== undefined) return value <= max ? 'pass' : 'fail'
  }
}

function parseStructuredResponse (response, structuredOutput) {
  if (typeof response !== 'string' || response.length === 0) {
    throw new Error('Invalid response: expected non-empty string')
  }
  let data
  try {
    data = JSON.parse(response)
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error.message}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid JSON response: expected object, got ${Array.isArray(data) ? 'array' : typeof data}`)
  }

  if (!(structuredOutput instanceof BaseStructuredOutput)) {
    return new EvaluatorResult(data, { reasoning: data.reasoning })
  }
  const value = data[structuredOutput.label]
  if (structuredOutput instanceof BooleanStructuredOutput && typeof value !== 'boolean') {
    throw new TypeError(`Expected boolean, got ${value === null ? 'null' : typeof value}`)
  }
  if (structuredOutput instanceof ScoreStructuredOutput && typeof value !== 'number') {
    throw new TypeError(`Expected number, got ${value === null ? 'null' : typeof value}`)
  }
  if (structuredOutput instanceof CategoricalStructuredOutput && typeof value !== 'string') {
    throw new TypeError(`Expected string, got ${value === null ? 'null' : typeof value}`)
  }
  const options = {
    assessment: computeAssessment(structuredOutput, value),
    metadata: { rawResponse: data },
  }
  if (structuredOutput.reasoning) options.reasoning = data.reasoning
  return new EvaluatorResult(value, options)
}

/**
 * Evaluator that uses an LLM to judge an experiment row.
 */
class LLMJudge extends BaseEvaluator {
  /**
   * @param {{userPrompt: string, systemPrompt?: string, structuredOutput?: BaseStructuredOutput | object,
   *   provider?: string, model?: string, modelParams?: object, client?: Function,
   *   clientOptions?: object, name?: string}} options
   */
  constructor (options) {
    const values = valuesOrEmpty(options)
    super(option(values, 'name', 'name'))
    const userPrompt = option(values, 'userPrompt', 'user_prompt')
    if (typeof userPrompt !== 'string') throw new TypeError('userPrompt must be a string')
    const provider = values.provider
    if (provider !== undefined && !SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`Unsupported LLM provider '${provider}'. Expected one of ${SUPPORTED_PROVIDERS.join(', ')}`)
    }
    const client = values.client
    if (client !== undefined && typeof client !== 'function') throw new TypeError('client must be a callable function')
    if (!client && provider === undefined) throw new Error('Provide either client or provider')

    this.userPrompt = userPrompt
    this.systemPrompt = option(values, 'systemPrompt', 'system_prompt')
    this.structuredOutput = values.structuredOutput ?? values.structured_output
    this.provider = provider
    this.model = values.model
    this.modelParams = values.modelParams ?? values.model_params
    this.clientOptions = values.clientOptions ?? values.client_options ?? {}
    this.client = client || createProviderClient(provider, this.clientOptions)
  }

  /**
   * @param {import('./evaluator').EvaluatorContext} context
   * @returns {string | EvaluatorResult | Promise<string | EvaluatorResult>}
   */
  evaluate (context) {
    if (typeof this.model !== 'string' || this.model.length === 0) throw new Error('model must be specified')
    const messages = []
    if (this.systemPrompt) messages.push({ role: 'system', content: this.systemPrompt })
    messages.push({ role: 'user', content: renderPrompt(this.userPrompt, context) })
    const schema = this.structuredOutput instanceof BaseStructuredOutput
      ? this.structuredOutput.toJsonSchema()
      : this.structuredOutput
    const response = this.client(this.provider, messages, schema, this.model, this.modelParams)
    const parse = value => this.structuredOutput == null
      ? value
      : parseStructuredResponse(value, this.structuredOutput)
    return isPromiseLike(response) ? response.then(parse) : parse(response)
  }
}

module.exports = {
  BaseStructuredOutput,
  BooleanStructuredOutput,
  CategoricalStructuredOutput,
  LLMJudge,
  ScoreStructuredOutput,
}
