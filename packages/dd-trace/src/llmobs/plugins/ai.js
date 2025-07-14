'use strict'

const BaseLLMObsPlugin = require('./base')
const { getModelProvider } = require('../../../../datadog-plugin-ai/src/utils')

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
 * @param {Record<string, string>} tags
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
 * @returns {Record<string, string> | null}
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

  return Object.keys(modelMetadata).length ? modelMetadata : null
}

/**
 * Get the generation metadata from the span tags (maxSteps, maxRetries, etc.)
 * @param {Record<string, string>} tags
 * @returns {Record<string, string> | null}
 */
function getGenerationMetadata (tags) {
  const metadata = {}

  for (const tag of Object.keys(tags)) {
    if (!tag.startsWith('ai.settings')) continue

    const settingKey = tag.split('.').pop()
    const transformedKey = settingKey.replaceAll(/[A-Z]/g, letter => '_' + letter.toLowerCase())
    if (MODEL_METADATA_KEYS.has(transformedKey)) continue

    const settingValue = tags[tag]
    metadata[settingKey] = settingValue
  }

  return Object.keys(metadata).length ? metadata : null
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

    const metadata = getGenerationMetadata(tags) ?? {}
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

    const inputMessages = getJsonStringValue(tags['ai.prompt.messages'], [])
    const parsedInputMessages = []
    for (const message of inputMessages) {
      const formattedMessages = this.formatMessage(message, toolsForModel)
      parsedInputMessages.push(...formattedMessages)
    }

    const outputMessage = this.formatOutputMessage(tags, toolsForModel)

    this._tagger.tagLLMIO(span, parsedInputMessages, outputMessage)

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

  /**
   * Returns a list of formatted messages from a message object.
   * Most of these will just be one entry, but in the case of a "tool" role,
   * it is possible to have multiple tool call results in a single message that we
   * need to split into multiple messages.
   *
   * @param {*} message
   * @param {*} toolsForModel
   * @returns {Array<{role: string, content: string, toolId?: string,
   *   toolCalls?: Array<{arguments: string, name: string, toolId: string, type: string}>}>}
   */
  formatMessage (message, toolsForModel) {
    const { role, content } = message

    if (role === 'system') {
      return [{ role, content }]
    } else if (role === 'user') {
      let finalContent = ''
      for (const part of content) {
        const { type } = part
        if (type === 'text') {
          finalContent += part.text
        }
      }

      return [{ role, content: finalContent }]
    } else if (role === 'assistant') {
      const toolCalls = []
      let finalContent = ''

      for (const part of content) {
        const { type } = part
        // TODO(sabrenner): do we want to include reasoning?
        if (['text', 'reasoning', 'redacted-reasoning'].includes(type)) {
          finalContent += part.text ?? part.data
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

      const finalMessage = {
        role,
        content: finalContent
      }

      if (toolCalls.length) {
        finalMessage.toolCalls = toolCalls.length ? toolCalls : undefined
      }

      return [finalMessage]
    } else if (role === 'tool') {
      const finalMessages = []
      for (const part of content) {
        if (part.type === 'tool-result') {
          let safeResult
          if (typeof part.result === 'string') {
            safeResult = part.result
          } else {
            try {
              safeResult = JSON.stringify(part.result)
            } catch {
              safeResult = '[Unparsable Tool Result]'
            }
          }

          finalMessages.push({
            role,
            content: safeResult,
            toolId: part.toolCallId
          })
        }
      }

      return finalMessages
    }

    return []
  }
}

module.exports = VercelAILLMObsPlugin
