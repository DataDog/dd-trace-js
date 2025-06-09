'use strict'

const BaseLLMObsPlugin = require('./base')

const { channel } = require('dc-polyfill')

const otelSpanStartCh = channel('dd-trace:otel:span:start')
const otelSpanFinishCh = channel('dd-trace:otel:span:finish')
const toolCreationCh = channel('dd-trace:vercel-ai:tool')

const { isVercelAISpan } = require('../../../../datadog-plugin-vercel-ai/src/util')
const { MODEL_NAME, MODEL_PROVIDER, NAME } = require('../constants/tags')

const SPANS_TO_USE_LLMOBS_PARENT = new Set([
  'generateText',
  'streamText',
  'embed',
  'embedMany',
  'generateObject',
  'streamObject'
])

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

/**
 * @param {import('../../../../dd-trace/src/opentracing/span')} span
 * @param {string} tag
 * @returns {string}
 */
function getSpanTag (span, tag) {
  const value = span.context()._tags[tag]
  if (!value) return

  return value
}

/**
 * @param {import('../../../../dd-trace/src/opentracing/span')} span
 * @returns {string}
 */
function getOperation (span) {
  const name = span._name
  if (!name) return

  return name.split('.').pop()
}

function getUsage (span) {
  const inputTokens = getSpanTag(span, 'ai.usage.promptTokens')
  const outputTokens = getSpanTag(span, 'ai.usage.completionTokens')

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  }
}

/**
 * @param {import('../../../../dd-trace/src/opentracing/span')} span
 * @returns {string}
 */
function getModelProvider (span) {
  const modelProviderTag = span.context()._tags['ai.model.provider']
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

function getJsonStringValue (str, defaultValue) {
  let maybeValue = defaultValue
  try {
    maybeValue = JSON.parse(str)
  } catch {
    // do nothing
  }

  return maybeValue
}

function getModelMetadata (span) {
  const modelMetadata = {}
  for (const metadata of MODEL_METADATA_KEYS) {
    const metadataTagKey = `gen_ai.request.${metadata}`
    const metadataValue = getSpanTag(span, metadataTagKey)
    if (metadataValue) {
      modelMetadata[metadata] = metadataValue
    }
  }

  return modelMetadata
}

function getGenerationMetadata (span) {
  const metadata = {}
  for (const tag of Object.keys(span.context()._tags)) {
    if (!tag.startsWith('ai.settings')) continue

    const settingKey = tag.split('.').pop()
    const transformedKey = settingKey.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
    if (MODEL_METADATA_KEYS.has(transformedKey)) continue

    const settingValue = getSpanTag(span, tag)
    metadata[settingKey] = settingValue
  }

  return metadata
}

class VercelAILLMObsPlugin extends BaseLLMObsPlugin {
  static get id () { return 'vercel-ai' }
  static get integration () { return 'vercel-ai' }

  /** @type {Set<Record<string, any>>} */
  #availableTools

  /** @type {Record<string, string>} */
  #toolCallIdsToName

  constructor (...args) {
    super(...args)

    otelSpanStartCh.subscribe(({ ddSpan }) => {
      if (!isVercelAISpan(ddSpan)) return

      // holding context for llmobs parentage
      const ctx = {
        currentStore: { span: ddSpan }
      }

      const operation = getOperation(ddSpan)
      const useLlmObsParent = SPANS_TO_USE_LLMOBS_PARENT.has(operation)

      this.start(ctx, {
        useLlmObsParent,
        enterIntoLlmObsStorage: false
      }) // triggers the getLLMObsSpanRegisterOptions
    })

    otelSpanFinishCh.subscribe(({ ddSpan }) => {
      if (!isVercelAISpan(ddSpan)) return

      const ctx = {
        currentStore: { span: ddSpan }
      }

      this.asyncEnd(ctx) // triggers the setLLMObsTags
    })

    this.#toolCallIdsToName = {}
    this.#availableTools = new Set()
    toolCreationCh.subscribe(toolArgs => {
      this.#availableTools.add(toolArgs)
    })
  }

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

    if (['embedding', 'llm'].includes(kind)) {
      this._tagger._setTag(span, MODEL_NAME, getSpanTag(span, 'ai.model.id'))
      this._tagger._setTag(span, MODEL_PROVIDER, getModelProvider(span))
    }

    switch (operation) {
      case 'embed':
      case 'embedMany':
        this.setEmbeddingWorkflowTags(span)
        break
      case 'doEmbed':
        this.setEmbeddingTags(span)
        break
      case 'generateObject':
      case 'streamObject':
        this.setObjectGenerationTags(span)
        break
      case 'generateText':
      case 'streamText':
        this.setTextGenerationTags(span)
        break
      case 'doGenerate':
      case 'doStream':
        this.setLLMOperationTags(span)
        break
      case 'toolCall':
        this.setToolTags(span)
        break
      default:
        break
    }
  }

  setEmbeddingWorkflowTags (span) {
    const inputs = getSpanTag(span, 'ai.value') ?? getSpanTag(span, 'ai.values')
    const parsedInputs = Array.isArray(inputs)
      ? inputs.map(input => getJsonStringValue(input, ''))
      : getJsonStringValue(inputs, '')

    const embeddingsOutput = getSpanTag(span, 'ai.embedding') ?? getSpanTag(span, 'ai.embeddings')
    const isSingleEmbedding = !Array.isArray(embeddingsOutput)
    const numberOfEmbeddings = isSingleEmbedding ? 1 : embeddingsOutput.length
    const embeddingsLength = getJsonStringValue(isSingleEmbedding ? embeddingsOutput : embeddingsOutput?.[0], []).length
    const output = `[${numberOfEmbeddings} embedding(s) returned with size ${embeddingsLength}]`

    this._tagger.tagTextIO(span, parsedInputs, output)

    const metadata = getGenerationMetadata(span)
    this._tagger.tagMetadata(span, metadata)
  }

  setEmbeddingTags (span) {
    const inputs = getSpanTag(span, 'ai.values')
    const parsedInputs = inputs.map(input => getJsonStringValue(input, ''))

    const embeddingsOutput = getSpanTag(span, 'ai.embeddings')
    const numberOfEmbeddings = embeddingsOutput?.length
    const embeddingsLength = getJsonStringValue(embeddingsOutput?.[0], []).length
    const output = `[${numberOfEmbeddings} embedding(s) returned with size ${embeddingsLength}]`

    this._tagger.tagEmbeddingIO(span, parsedInputs, output)

    const usage = getSpanTag(span, 'ai.usage.tokens')
    this._tagger.tagMetrics(span, {
      inputTokens: usage,
      totalTokens: usage
    })
  }

  setObjectGenerationTags (span) {
    const promptInfo = getJsonStringValue(getSpanTag(span, 'ai.prompt'), {})
    const lastUserPrompt =
      promptInfo.prompt ??
      promptInfo.messages.reverse().find(message => message.role === 'user')?.content
    const prompt = Array.isArray(lastUserPrompt) ? lastUserPrompt.map(part => part.text ?? '').join('') : lastUserPrompt

    const output = getSpanTag(span, 'ai.response.object')

    this._tagger.tagTextIO(span, prompt, output)

    const metadata = getGenerationMetadata(span)
    metadata.schema = getSpanTag(span, 'ai.schema')
    this._tagger.tagMetadata(span, metadata)
  }

  setTextGenerationTags (span) {
    const promptInfo = getJsonStringValue(getSpanTag(span, 'ai.prompt'), {})
    const lastUserPrompt =
      promptInfo.prompt ??
      promptInfo.messages.reverse().find(message => message.role === 'user')?.content
    const prompt = Array.isArray(lastUserPrompt) ? lastUserPrompt.map(part => part.text ?? '').join('') : lastUserPrompt

    const output = getSpanTag(span, 'ai.response.text')

    this._tagger.tagTextIO(span, prompt, output)

    const metadata = getGenerationMetadata(span)
    this._tagger.tagMetadata(span, metadata)
  }

  setLLMOperationTags (span) {
    const toolsForModel = getSpanTag(span, 'ai.prompt.tools')?.map(getJsonStringValue)
    const inputMessages = getJsonStringValue(getSpanTag(span, 'ai.prompt.messages'), [])?.map(
      message => this.formatMessage(message, toolsForModel)
    )
    const outputMessage = this.formatOutputMessage(span, toolsForModel)

    this._tagger.tagLLMIO(span, inputMessages, outputMessage)

    const metadata = getModelMetadata(span)
    this._tagger.tagMetadata(span, metadata)

    const usage = getUsage(span)
    this._tagger.tagMetrics(span, usage)
  }

  setToolTags (span) {
    const toolCallId = getSpanTag(span, 'ai.toolCall.id')
    const name = this.#toolCallIdsToName[toolCallId]
    if (name) this._tagger._setTag(span, NAME, name)

    const input = getJsonStringValue(getSpanTag(span, 'ai.toolCall.args'))
    const output = getJsonStringValue(getSpanTag(span, 'ai.toolCall.result'))

    this._tagger.tagTextIO(span, input, output)
  }

  formatOutputMessage (span, toolsForModel) {
    const outputMessageText = getSpanTag(span, 'ai.response.text') ?? getSpanTag(span, 'ai.response.object')
    const outputMessageToolCalls = getJsonStringValue(getSpanTag(span, 'ai.response.toolCalls'), [])

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
    }

    // TODO(sabrenner): add support for tool messages in a follow-up once BE supports it
    // role === 'tool'

    return finalMessage
  }
}

module.exports = VercelAILLMObsPlugin
