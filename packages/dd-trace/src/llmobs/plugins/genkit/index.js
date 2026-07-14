'use strict'

const LLMObsPlugin = require('../base')

const providerIntegrations = {
  googleai: { integration: 'google-genai', provider: 'google' },
}

const operationKinds = {
  embedder: { kind: 'embedding', type: 'embedding' },
  flow: { kind: 'workflow', type: 'flow' },
  model: { kind: 'llm', type: 'generation' },
  retriever: { kind: 'retrieval', type: 'retrieval' },
  tool: { kind: 'tool', type: 'tool' },
}

/**
 * Select the Genkit options argument for either supported runInNewSpan overload.
 *
 * @param {object} ctx Orchestrion call context.
 * @returns {object|undefined} Genkit span options.
 */
function getOptions (ctx) {
  return ctx.arguments?.length === 3 ? ctx.arguments[1] : ctx.arguments?.[0]
}

/**
 * Resolve an allowlisted Genkit operation from its native labels.
 *
 * @param {object} options Genkit span options.
 * @returns {{kind: string, type: string}|undefined} LLMObs operation definition.
 */
function getOperation (options) {
  const labels = options?.labels
  if (labels?.['genkit:type'] === 'flowStep') {
    return { kind: 'workflow', type: 'flowStep' }
  }

  return operationKinds[labels?.['genkit:metadata:subtype']]
}

/**
 * Resolve a source-proven provider prefix from a registered Genkit action name.
 *
 * @param {unknown} actionName Registered Genkit action name.
 * @returns {{integration: string, provider: string}|undefined} Supported provider definition.
 */
function getProvider (actionName) {
  if (typeof actionName !== 'string') return

  const separator = actionName.indexOf('/')
  if (separator === -1) return

  return providerIntegrations[actionName.slice(0, separator)]
}

/**
 * Determine whether a supported provider owns the authoritative LLMObs span.
 *
 * @param {{integration: string}|undefined} provider Supported provider definition.
 * @returns {boolean} Whether the provider LLMObs plugin is enabled.
 */
function isProviderIntegrationEnabled (provider) {
  const pluginManager = require('../../../../../..')._pluginManager
  return !!provider && pluginManager?._pluginsByName[provider.integration]?.llmobs?._enabled === true
}

/**
 * Parse Genkit's serialized output metadata without allowing malformed metadata to affect the application.
 *
 * @param {unknown} output Serialized output metadata.
 * @returns {unknown} Parsed output, when available.
 */
function parseOutput (output) {
  let parsed
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output)
    } catch {}
  }
  return parsed
}

/**
 * Read an operation result, falling back to Genkit's mutable serialized metadata.
 *
 * @param {object} ctx Orchestrion call context.
 * @param {object} options Genkit span options.
 * @returns {unknown} Operation result.
 */
function getResult (ctx, options) {
  return ctx.result === undefined ? parseOutput(options?.metadata?.output) : ctx.result
}

/**
 * Convert a value into the string field required by LLMObs tool results.
 *
 * @param {unknown} value Tool output.
 * @returns {string} Safely serialized tool output.
 */
function stringifyToolResult (value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Convert a Genkit tool input into the object field required by LLMObs tool calls.
 *
 * @param {unknown} value Tool input.
 * @returns {object|undefined} Tool arguments.
 */
function formatToolArguments (value) {
  if (value == null) return
  if (typeof value === 'object') return value
  return { value }
}

/**
 * Normalize Genkit messages and safe Part variants to the LLMObs message contract.
 *
 * @param {unknown} messages Genkit messages.
 * @returns {object[]} Normalized messages.
 */
function formatMessages (messages) {
  if (!Array.isArray(messages)) return []

  const formatted = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue

    const parts = Array.isArray(message.content) ? message.content : []
    const text = []
    const toolCalls = []
    const toolResults = []

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue

      if (typeof part.text === 'string') text.push(part.text)

      const request = part.toolRequest
      if (request && typeof request === 'object' && typeof request.name === 'string') {
        const toolCall = { name: request.name }
        const args = formatToolArguments(request.input)
        if (args) toolCall.arguments = args
        if (typeof request.ref === 'string') toolCall.toolId = request.ref
        toolCalls.push(toolCall)
      }

      const response = part.toolResponse
      if (response && typeof response === 'object' && typeof response.name === 'string') {
        const toolResult = {
          name: response.name,
          result: stringifyToolResult(response.output),
        }
        if (typeof response.ref === 'string') toolResult.toolId = response.ref
        toolResults.push(toolResult)
      }
    }

    const formattedMessage = {
      role: message.role === 'model' ? 'assistant' : message.role || '',
    }
    if (text.length) formattedMessage.content = text.join('')
    if (toolCalls.length) formattedMessage.toolCalls = toolCalls
    if (toolResults.length) formattedMessage.toolResults = toolResults
    formatted.push(formattedMessage)
  }

  return formatted
}

/**
 * Join only text parts from a Genkit document.
 *
 * @param {unknown} document Genkit document.
 * @returns {string} Document text.
 */
function getDocumentText (document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.content)) return ''

  let text = ''
  for (const part of document.content) {
    if (typeof part?.text === 'string') text += part.text
  }
  return text
}

/**
 * Convert Genkit documents to the strict LLMObs document shape.
 *
 * @param {unknown} documents Genkit documents.
 * @param {boolean} includeScore Whether reviewed retrieval scores may be copied.
 * @returns {object[]} Normalized documents.
 */
function formatDocuments (documents, includeScore = false) {
  if (!Array.isArray(documents)) return []

  const formatted = []
  for (const document of documents) {
    if (!document || typeof document !== 'object') continue

    const item = { text: getDocumentText(document) }
    const metadata = document.metadata
    if (metadata && typeof metadata === 'object') {
      if (typeof metadata.name === 'string') item.name = metadata.name
      if (typeof metadata.id === 'string') item.id = metadata.id
      if (includeScore && typeof metadata.score === 'number') item.score = metadata.score
    }
    formatted.push(item)
  }

  return formatted
}

/**
 * Extract only reviewed scalar generation metadata.
 *
 * @param {object} input Genkit model input.
 * @param {object} response Genkit model response.
 * @returns {object} LLMObs metadata.
 */
function extractMetadata (input, response) {
  const config = input?.config
  const metadata = {}

  if (config && typeof config === 'object') {
    if (typeof config.version === 'string') metadata.version = config.version
    if (typeof config.temperature === 'number') metadata.temperature = config.temperature
    if (typeof config.maxOutputTokens === 'number') metadata.max_output_tokens = config.maxOutputTokens
    if (typeof config.topK === 'number') metadata.top_k = config.topK
    if (typeof config.topP === 'number') metadata.top_p = config.topP
  }
  if (typeof input?.toolChoice === 'string') metadata.tool_choice = input.toolChoice
  if (typeof response?.finishReason === 'string') metadata.finish_reason = response.finishReason
  if (typeof response?.latencyMs === 'number') metadata.latency_ms = response.latencyMs

  return metadata
}

/**
 * Extract standard Genkit token metrics without relabeling provider-specific usage.
 *
 * @param {object} response Genkit model response.
 * @returns {object} Numeric token metrics.
 */
function extractMetrics (response) {
  const usage = response?.usage
  const metrics = {}
  if (typeof usage?.inputTokens === 'number') metrics.inputTokens = usage.inputTokens
  if (typeof usage?.outputTokens === 'number') metrics.outputTokens = usage.outputTokens
  if (typeof usage?.totalTokens === 'number') metrics.totalTokens = usage.totalTokens
  return metrics
}

/**
 * Summarize embedding vectors without recording their numeric contents.
 *
 * @param {unknown} embeddings Genkit embedding output.
 * @returns {string} Count and common vector size summary.
 */
function summarizeEmbeddings (embeddings) {
  if (!Array.isArray(embeddings)) return ''

  const count = embeddings.length
  let size
  for (const item of embeddings) {
    const currentSize = Array.isArray(item?.embedding) ? item.embedding.length : undefined
    if (currentSize === undefined || (size !== undefined && currentSize !== size)) {
      size = undefined
      break
    }
    size = currentSize
  }

  return size === undefined
    ? `[${count} embedding(s) returned]`
    : `[${count} embedding(s) returned with size ${size}]`
}

class GenkitLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_genkit'
  static integration = 'genkit'
  static prefix = 'tracing:orchestrion:@genkit-ai/core:runInNewSpan'

  /**
   * Register an LLMObs span for an allowlisted Genkit operation.
   *
   * @param {object} ctx Orchestrion call context.
   * @returns {object|undefined} LLMObs registration options.
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const options = getOptions(ctx)
    const operation = getOperation(options)
    if (!ctx.genkit || !operation) return

    const actionName = ctx.genkit.actionName || options?.metadata?.name
    const provider = getProvider(actionName)
    const providerOwned = operation.type === 'generation' && isProviderIntegrationEnabled(provider)
    const kind = providerOwned ? 'workflow' : operation.kind

    ctx.genkit.llmobsKind = kind

    return {
      kind,
      name: actionName || `genkit.${operation.type}`,
      ...(kind === 'llm' || kind === 'embedding'
        ? { modelName: actionName, modelProvider: provider?.provider }
        : undefined),
    }
  }

  /**
   * Apply normalized Genkit input, output, metadata, and metrics to the registered LLMObs span.
   *
   * @param {object} ctx Orchestrion call context.
   * @returns {void}
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const options = getOptions(ctx)
    const operation = getOperation(options)
    if (!span || !ctx.genkit || !operation) return

    const input = options?.metadata?.input
    const result = getResult(ctx, options)

    if (operation.kind === 'llm' && ctx.genkit.llmobsKind === 'workflow') {
      this._tagger.tagTextIO(span, input, ctx.error ? '' : result)
      return
    }

    switch (operation.kind) {
      case 'llm':
        this.#tagLLM(span, input, result, ctx.error)
        break
      case 'workflow':
      case 'tool':
        this._tagger.tagTextIO(span, input, ctx.error ? '' : result)
        break
      case 'retrieval':
        this.#tagRetrieval(span, input, result, ctx.error)
        break
      case 'embedding':
        this.#tagEmbedding(span, input, result, ctx.error)
        break
    }
  }

  /**
   * Leave APM error tagging to the tracing member of the composite plugin.
   *
   * @returns {void}
   */
  error () {}

  /**
   * Restore LLMObs context only for operations registered by this plugin.
   *
   * @param {object} ctx Orchestrion call context.
   * @returns {void}
   */
  end (ctx) {
    if (!ctx.llmobs) return
    super.end(ctx)
  }

  /**
   * Tag one Genkit model action.
   *
   * @param {object} span Datadog span.
   * @param {object} input Genkit model input.
   * @param {object} response Genkit model response.
   * @param {unknown} error Operation error.
   * @returns {void}
   */
  #tagLLM (span, input, response, error) {
    const inputMessages = formatMessages(input?.messages)
    const outputMessages = error
      ? [{ content: '', role: '' }]
      : formatMessages(response?.message ? [response.message] : [])

    if (!outputMessages.length) outputMessages.push({ content: '', role: '' })
    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
    this._tagger.tagMetadata(span, extractMetadata(input, response))
    this._tagger.tagMetrics(span, extractMetrics(response))
  }

  /**
   * Tag one Genkit retriever action.
   *
   * @param {object} span Datadog span.
   * @param {object} input Genkit retriever input.
   * @param {object} response Genkit retriever response.
   * @param {unknown} error Operation error.
   * @returns {void}
   */
  #tagRetrieval (span, input, response, error) {
    const query = getDocumentText(input?.query)
    const documents = error ? [] : formatDocuments(response?.documents, true)
    this._tagger.tagRetrievalIO(span, query, documents)
  }

  /**
   * Tag one Genkit embedder action without serializing vectors.
   *
   * @param {object} span Datadog span.
   * @param {object} input Genkit embedder input.
   * @param {object} response Genkit embedder response.
   * @param {unknown} error Operation error.
   * @returns {void}
   */
  #tagEmbedding (span, input, response, error) {
    const documents = formatDocuments(input?.input)
    const output = error ? '' : summarizeEmbeddings(response?.embeddings)
    this._tagger.tagEmbeddingIO(span, documents, output)
  }
}

module.exports = GenkitLLMObsPlugin
