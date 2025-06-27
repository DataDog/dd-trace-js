'use strict'

const BaseLLMObsPlugin = require('./base')

const { channel } = require('dc-polyfill')

const toolCreationCh = channel('dd-trace:vercel-ai:tool')
const setAttributesCh = channel('dd-trace:vercel-ai:span:setAttributes')

const { MODEL_NAME, MODEL_PROVIDER, NAME } = require('../constants/tags')

const SPAN_NAME_TO_KIND_MAPPING = {
  // embeddings
  embed: 'workflow',
  embedMany: 'workflow',
  doEmbed: 'embedding',
  // object generation
  generateObject: 'workflow',
  streamObject: 'workflow',
  // text generation
  generateText: 'workflow',
  streamText: 'workflow',
  // llm operations
  doGenerate: 'llm',
  doStream: 'llm',
  // tools
  toolCall: 'tool'
}

const MODEL_PROVIDER_MAPPING = {
  'amazon-bedrock': 'bedrock',
  vertex: 'vertexai',
  'generative-ai': 'genai' // TODO(sabrenner): double check this
}

const MODEL_METADATA_KEYS = new Set([
  'frequency_penalty',
  'max_tokens',
  'presence_penalty',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences'
])

function getSpanTags (ctx) {
  const span = ctx.currentStore?.span
  const carrier = ctx.attributes ?? span?.context()._tags ?? {}
  return carrier
}

/**
 * Get the operation name from the span name
 *
 * @example
 * span._name = 'ai.generateText'
 * getOperation(span) // 'generateText'
 *
 * @example
 * span._name = 'ai.generateText.doGenerate'
 * getOperation(span) // 'doGenerate'
 *
 * @param {import('../../opentracing/span')} span
 * @returns {string}
 */
function getOperation (span) {
  const name = span._name
  if (!name) return

  return name.split('.').pop()
}

/**
 * Get the LLM token usage from the span tags
 * @param {import('../../opentracing/span')} span
 * @returns {{inputTokens: number, outputTokens: number, totalTokens: number}}
 */
function getUsage (tags) {
  const usage = {}
  const inputTokens = tags['ai.usage.promptTokens']
  const outputTokens = tags['ai.usage.completionTokens']

  if (inputTokens != null) usage.inputTokens = inputTokens
  if (outputTokens != null) usage.outputTokens = outputTokens

  const totalTokens = inputTokens + outputTokens
  if (!Number.isNaN(totalTokens)) usage.totalTokens = totalTokens

  return usage
}

/**
 * Get the model provider from the span tags.
 * This is normalized to LLM Observability model provider standards.
 *
 * @param {import('../../opentracing/span')} span
 * @returns {string}
 */
function getModelProvider (tags) {
  const modelProviderTag = tags['ai.model.provider']
  const providerParts = modelProviderTag?.split('.')
  const provider = providerParts?.[0]

  // TODO(sabrenner): explain or simplify this logic
  switch (provider) {
    case 'google':
      return MODEL_PROVIDER_MAPPING[providerParts?.[1]] ?? provider
    default:
      return MODEL_PROVIDER_MAPPING[provider] ?? provider
  }
}

/**
 * Safely JSON parses a string value with a default fallback
 * @param {string} str
 * @param {any} defaultValue
 * @returns {Record<string, any> | string | Array<any>}
 */
function getJsonStringValue (str, defaultValue) {
  let maybeValue = defaultValue
  try {
    maybeValue = JSON.parse(str)
  } catch {
    // do nothing
  }

  return maybeValue
}

/**
 * Get the model metadata from the span tags (top_p, top_k, temperature, etc.)
 * @param {import('../../opentracing/span')} span
 * @returns {Record<string, string>}
 */
function getModelMetadata (tags) {
  const modelMetadata = {}
  for (const metadata of MODEL_METADATA_KEYS) {
    const metadataTagKey = `gen_ai.request.${metadata}`
    const metadataValue = tags[metadataTagKey]
    if (metadataValue) {
      modelMetadata[metadata] = metadataValue
    }
  }

  return modelMetadata
}

/**
 * Get the generation metadata from the span tags (maxSteps, maxRetries, etc.)
 * @param {import('../../opentracing/span')} span
 * @returns {Record<string, string>}
 */
function getGenerationMetadata (ctx) {
  const metadata = {}
  const tags = getSpanTags(ctx)

  for (const tag of Object.keys(tags)) {
    if (!tag.startsWith('ai.settings')) continue

    const settingKey = tag.split('.').pop()
    const transformedKey = settingKey.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
    if (MODEL_METADATA_KEYS.has(transformedKey)) continue

    const settingValue = tags[tag]
    metadata[settingKey] = settingValue
  }

  return metadata
}

class VercelAILLMObsPlugin extends BaseLLMObsPlugin {
  static get id () { return 'ai' }
  static get integration () { return 'vercel-ai' } // for LLMObs telemetry - "vercel-ai" makes more sense than "ai"
  static get prefix () { return 'tracing:dd-trace:vercel-ai' }

  /**
   * The available tools within the runtime scope of this integration.
   * This essentially acts as a global registry for all tools made through the Vercel AI SDK.
   * @type {Set<Record<string, any>>}
   */
  #availableTools

  /**
   * A mapping of tool call IDs to tool names.
   * This is used to map the tool call ID to the tool name for the output message.
   * @type {Record<string, string>}
   */
  #toolCallIdsToName

  constructor (...args) {
    super(...args)

    this.#toolCallIdsToName = {}
    this.#availableTools = new Set()
    toolCreationCh.subscribe(toolArgs => {
      this.#availableTools.add(toolArgs)
    })

    setAttributesCh.subscribe(({ ctx, attributes }) => {
      Object.assign(ctx.attributes, attributes)
    })
  }

  /**
   * Does a best-effort attempt to find the right tool name for the given tool description.
   * This is because the Vercel AI SDK does not tag tools by name properly, but
   * rather by the index they were passed in. Tool names appear nowhere in the span tags.
   *
   * We use the tool description as the next best identifier for a tool.
   *
   * @param {string} toolDescription
   * @returns {string}
   */
  findToolName (toolDescription) {
    for (const availableTool of this.#availableTools) {
      const description = availableTool.description
      if (description === toolDescription) {
        return availableTool.id
      }
    }
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore.span
    const operation = getOperation(span)
    const kind = SPAN_NAME_TO_KIND_MAPPING[operation]
    if (!kind) return

    return { kind, name: operation }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore.span
    if (!span) return

    const operation = getOperation(span)
    const kind = SPAN_NAME_TO_KIND_MAPPING[operation]
    if (!kind) return

    const tags = getSpanTags(ctx)

    if (['embedding', 'llm'].includes(kind)) {
      this._tagger._setTag(span, MODEL_NAME, tags['ai.model.id'])
      this._tagger._setTag(span, MODEL_PROVIDER, getModelProvider(tags))
    }

    switch (operation) {
      case 'embed':
      case 'embedMany':
        this.setEmbeddingWorkflowTags(span, tags)
        break
      case 'doEmbed':
        this.setEmbeddingTags(span, tags)
        break
      case 'generateObject':
      case 'streamObject':
        this.setObjectGenerationTags(span, tags)
        break
      case 'generateText':
      case 'streamText':
        this.setTextGenerationTags(span, tags)
        break
      case 'doGenerate':
      case 'doStream':
        this.setLLMOperationTags(span, tags)
        break
      case 'toolCall':
        this.setToolTags(span, tags)
        break
      default:
        break
    }
  }

  setEmbeddingWorkflowTags (span, tags) {
    const inputs = tags['ai.value'] ?? tags['ai.values']
    const parsedInputs = Array.isArray(inputs)
      ? inputs.map(input => getJsonStringValue(input, ''))
      : getJsonStringValue(inputs, '')

    const embeddingsOutput = tags['ai.embedding'] ?? tags['ai.embeddings']
    const isSingleEmbedding = !Array.isArray(embeddingsOutput)
    const numberOfEmbeddings = isSingleEmbedding ? 1 : embeddingsOutput.length
    const embeddingsLength = getJsonStringValue(isSingleEmbedding ? embeddingsOutput : embeddingsOutput?.[0], []).length
    const output = `[${numberOfEmbeddings} embedding(s) returned with size ${embeddingsLength}]`

    this._tagger.tagTextIO(span, parsedInputs, output)

    const metadata = getGenerationMetadata(tags)
    this._tagger.tagMetadata(span, metadata)
  }

  setEmbeddingTags (span, tags) {
    const inputs = tags['ai.values']
    const parsedInputs = inputs.map(input => getJsonStringValue(input, ''))

    const embeddingsOutput = tags['ai.embeddings']
    const numberOfEmbeddings = embeddingsOutput?.length
    const embeddingsLength = getJsonStringValue(embeddingsOutput?.[0], []).length
    const output = `[${numberOfEmbeddings} embedding(s) returned with size ${embeddingsLength}]`

    this._tagger.tagEmbeddingIO(span, parsedInputs, output)

    const usage = tags['ai.usage.tokens']
    this._tagger.tagMetrics(span, {
      inputTokens: usage,
      totalTokens: usage
    })
  }

  setObjectGenerationTags (span, tags) {
    const promptInfo = getJsonStringValue(tags['ai.prompt'], {})
    const lastUserPrompt =
      promptInfo.prompt ??
      promptInfo.messages.reverse().find(message => message.role === 'user')?.content
    const prompt = Array.isArray(lastUserPrompt) ? lastUserPrompt.map(part => part.text ?? '').join('') : lastUserPrompt

    const output = tags['ai.response.object']

    this._tagger.tagTextIO(span, prompt, output)

    const metadata = getGenerationMetadata(tags)
    metadata.schema = getJsonStringValue(tags['ai.schema'], {})
    this._tagger.tagMetadata(span, metadata)
  }

  setTextGenerationTags (span, tags) {
    const promptInfo = getJsonStringValue(tags['ai.prompt'], {})
    const lastUserPrompt =
      promptInfo.prompt ??
      promptInfo.messages.reverse().find(message => message.role === 'user')?.content
    const prompt = Array.isArray(lastUserPrompt) ? lastUserPrompt.map(part => part.text ?? '').join('') : lastUserPrompt

    const output = tags['ai.response.text']

    this._tagger.tagTextIO(span, prompt, output)

    const metadata = getGenerationMetadata(tags)
    this._tagger.tagMetadata(span, metadata)
  }

  setLLMOperationTags (span, tags) {
    const toolsForModel = tags['ai.prompt.tools']?.map(getJsonStringValue)
    const inputMessages = getJsonStringValue(tags['ai.prompt.messages'], [])?.map(
      message => this.formatMessage(message, toolsForModel)
    )
    const outputMessage = this.formatOutputMessage(tags, toolsForModel)

    this._tagger.tagLLMIO(span, inputMessages, outputMessage)

    const metadata = getModelMetadata(tags)
    this._tagger.tagMetadata(span, metadata)

    const usage = getUsage(tags)
    this._tagger.tagMetrics(span, usage)
  }

  setToolTags (span, tags) {
    const toolCallId = tags['ai.toolCall.id']
    const name = this.#toolCallIdsToName[toolCallId]
    if (name) this._tagger._setTag(span, NAME, name)

    const input = getJsonStringValue(tags['ai.toolCall.args'])
    const output = getJsonStringValue(tags['ai.toolCall.result'])

    this._tagger.tagTextIO(span, input, output)
  }

  formatOutputMessage (tags, toolsForModel) {
    const outputMessageText = tags['ai.response.text'] ?? tags['ai.response.object']
    const outputMessageToolCalls = getJsonStringValue(tags['ai.response.toolCalls'], [])

    const formattedToolCalls = []
    for (const toolCall of outputMessageToolCalls) {
      const toolCallArgs = getJsonStringValue(toolCall.args, {})
      const toolDescription = toolsForModel?.find(tool => toolCall.toolName === tool.name)?.description
      const name = this.findToolName(toolDescription)
      this.#toolCallIdsToName[toolCall.toolCallId] = name

      formattedToolCalls.push({
        arguments: toolCallArgs,
        name,
        toolId: toolCall.toolCallId,
        type: 'function'
      })
    }

    return {
      role: 'assistant',
      content: outputMessageText,
      toolCalls: formattedToolCalls
    }
  }

  formatMessage (message, toolsForModel) {
    const { role, content } = message
    const toolCalls = []

    const finalMessage = {
      role,
      content: ''
    }

    if (role === 'system') {
      finalMessage.content = content
    } else if (role === 'user') {
      for (const part of content) {
        const { type } = part
        if (type === 'text') {
          finalMessage.content += part.text
        }
      }
    } else if (role === 'assistant') {
      for (const part of content) {
        const { type } = part
        if (['text', 'reasoning', 'redacted-reasoning'].includes(type)) {
          finalMessage.content += part.text ?? part.data
        } else if (type === 'tool-call') {
          const toolDescription = toolsForModel?.find(tool => part.toolName === tool.name)?.description
          const name = this.findToolName(toolDescription)

          toolCalls.push({
            arguments: part.args,
            name,
            toolId: part.toolCallId,
            type: 'function'
          })
        }
      }

      if (toolCalls.length) {
        finalMessage.toolCalls = toolCalls
      }
    } else if (role === 'tool') {
      // TODO(sabrenner): add support for tool messages in a follow-up once BE supports it
      return
    }

    return finalMessage
  }
}

module.exports = VercelAILLMObsPlugin
