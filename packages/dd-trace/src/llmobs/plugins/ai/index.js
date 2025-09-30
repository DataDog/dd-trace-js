'use strict'

const BaseLLMObsPlugin = require('../base')
const { getModelProvider } = require('../../../../../datadog-plugin-ai/src/utils')

const { channel } = require('dc-polyfill')

const toolCreationCh = channel('dd-trace:vercel-ai:tool')
const setAttributesCh = channel('dd-trace:vercel-ai:span:setAttributes')

const { MODEL_NAME, MODEL_PROVIDER, NAME } = require('../../constants/tags')
const {
  getSpanTags,
  getOperation,
  getUsage,
  getJsonStringValue,
  getModelMetadata,
  getGenerationMetadata,
  getToolNameFromTags,
  getToolCallResultContent,
  getLlmObsSpanName
} = require('./util')

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

class VercelAILLMObsPlugin extends BaseLLMObsPlugin {
  static id = 'ai'
  static integration = 'ai'
  static prefix = 'tracing:dd-trace:vercel-ai'

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
      if (description === toolDescription && availableTool.id) {
        return availableTool.id
      }
    }
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const operation = getOperation(span)
    const kind = SPAN_NAME_TO_KIND_MAPPING[operation]
    if (!kind) return

    return { kind, name: getLlmObsSpanName(operation, ctx.attributes['ai.telemetry.functionId']) }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
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
    if (!Array.isArray(inputs)) return

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
    const name = getToolNameFromTags(tags) ?? this.#toolCallIdsToName[toolCallId]
    if (name) this._tagger._setTag(span, NAME, name)

    const input = tags['ai.toolCall.args']
    const output = tags['ai.toolCall.result']

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
          const safeResult = getToolCallResultContent(part)

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
