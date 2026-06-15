'use strict'

const { parseModelProvider } = require('../../../../../datadog-plugin-ai/src/utils')
const BaseLLMObsPlugin = require('../base')
const {
  getLlmObsSpanName,
  getGenerationMetadataFromEvent,
  getJsonStringValue,
  getToolCallResultContent,
} = require('./util')

// TODO: support rerank
const SPAN_NAME_TO_KIND_MAPPING = {
  // embeddings
  embed: 'embedding',
  embedMany: 'workflow',
  // text generation
  generateText: 'workflow',
  streamText: 'workflow',
  // llm operations
  languageModelCall: 'llm',
  // steps
  step: 'step', // TODO: support step spans for manual instrumentation as well
  // tools
  executeTool: 'tool',
}

function nameFromOperation (operation, event) {
  if (operation === 'executeTool') {
    return event.toolCall?.toolName
  }

  return operation
}

function formatLanguageModelInputMessages (instructions, messages) {
  if (!Array.isArray(messages)) return
  const inputMessages = []

  if (instructions) {
    const systemPrompt = typeof instructions === 'string'
      ? instructions
      : Array.isArray(instructions)
        ? instructions.map(instruction => instruction.content).join('')
        : instructions.content

    inputMessages.push({ role: 'system', content: systemPrompt })
  }

  for (const message of messages) {
    const { role, content } = message

    if (role === 'system') {
      inputMessages.push({ role, content })
    } else if (role === 'user') {
      const userMessageContent =
      typeof content === 'string'
        ? content
        : content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('')

      inputMessages.push({ role, content: userMessageContent })
    } else if (role === 'assistant') {
      if (typeof content === 'string') {
        inputMessages.push({ role, content })
      } else {
        // re-use existing output message formatting
        inputMessages.push(...formatLanguageModelOutputMessages(content))
      }
    } else if (role === 'tool') {
      for (const part of content) {
        if (part.type === 'tool-result') { // TODO: support tool approvals
          const safeResult = getToolCallResultContent(part)

          inputMessages.push({
            role,
            content: safeResult,
            toolId: part.toolCallId,
          })
        }
      }
    }
  }

  return inputMessages
}

function formatLanguageModelOutputMessages (content) {
  if (!Array.isArray(content)) return

  const outputMessages = []
  const toolCalls = []

  let textContent = ''
  let reasoningContent = ''

  for (const part of content) {
    const { type } = part

    if (type === 'text') {
      textContent += part.text
    } else if (type === 'reasoning') {
      reasoningContent += part.text
    } else if (type === 'tool-call') {
      const toolCallArguments = typeof part.input === 'string'
        ? getJsonStringValue(part.input, {})
        : part.input

      toolCalls.push({
        arguments: toolCallArguments,
        name: part.toolName,
        type: 'function',
        toolId: part.toolCallId,
      })
    }
  }

  if (reasoningContent) {
    outputMessages.push({ role: 'reasoning', content: reasoningContent })
  }

  const finalTextMessage = { role: 'assistant' }

  if (textContent) {
    finalTextMessage.content = textContent
  }

  if (toolCalls.length) {
    finalTextMessage.toolCalls = toolCalls
  }

  outputMessages.push(finalTextMessage)

  return outputMessages
}

class VercelAiTelemetryPlugin extends BaseLLMObsPlugin {
  static id = 'ai'
  static integration = 'ai'
  static prefix = 'tracing:ai:telemetry'

  /** @type {Map<string, Array<Record<string, unknown>>>} */
  #outputContentsByCallId = new Map()

  constructor () {
    super(...arguments)

    this.addSub('dd-trace:vercel-ai:chunk', ({ ctx, chunk, done }) => {
      ctx.chunks ??= []
      const chunks = ctx.chunks
      if (chunk) chunks.push(chunk)

      ctx.streamConsumed = done

      if (!done) return

      const contentById = {}

      for (const chunk of chunks) {
        if (chunk.type === 'finish') {
          ctx.result.usage = chunk.usage
        } else if (chunk.type === 'reasoning-start') {
          contentById[chunk.id] = { type: 'reasoning', text: '' }
        } else if (chunk.type === 'text-start') {
          contentById[chunk.id] = { type: 'text', text: '' }
        } else if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
          contentById[chunk.id].text += chunk.delta
        } else if (chunk.type === 'tool-call') {
          contentById[chunk.toolCallId] = chunk
        }
      }

      const content = Object.values(contentById)
      ctx.result.content = content

      const { callId } = ctx.event
      const outputContentForCallId = this.#outputContentsByCallId.get(callId)
      if (outputContentForCallId) {
        outputContentForCallId.push(content)
      } else {
        this.#outputContentsByCallId.set(callId, [content])
      }
    })
  }

  /**
   * @override
   */
  asyncEnd (ctx) {
    // check if isStreamed and stream resolved
    // this event will fire multiple times for the same channel
    if (ctx.isStream && ctx.result?.stream && !ctx.streamConsumed) return

    super.asyncEnd(ctx)
  }

  /**
   * @override
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { type: operation, event } = ctx
    const kind = SPAN_NAME_TO_KIND_MAPPING[operation]
    if (!kind) return

    const normalizedName = nameFromOperation(operation, event) || operation

    const options = {
      kind, name: getLlmObsSpanName(normalizedName, event.functionId),
    }

    if (kind === 'llm' || kind === 'embedding') {
      const modelName = event.modelId

      options.modelName = modelName
      options.modelProvider = parseModelProvider(event.provider, modelName)
    }

    return options
  }

  /**
   * @override
   */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { type: operation } = ctx
    const kind = SPAN_NAME_TO_KIND_MAPPING[operation]
    if (!kind) return

    switch (operation) {
      case 'embed':
        this.setEmbeddingTags(span, ctx)
        break
      case 'generateText':
      case 'streamText':
        this.setTextGenerationTags(span, ctx)
        break
      case 'languageModelCall':
        this.setLanguageModelCallTags(span, ctx)
        break
      case 'step':
        this.setStepTags(span, ctx)
        break
      case 'executeTool':
        this.setToolTags(span, ctx)
        break
      default:
        break
    }
  }

  setEmbeddingTags (span, ctx) {
    const { event, result } = ctx

    const input = event.value
    const embedding = result?.embedding
    const embeddingTextResult = `[1 embedding(s) returned with size ${embedding.length}]`

    this._tagger.tagEmbeddingIO(span, input, embeddingTextResult)

    this._tagger.tagMetrics(span, {
      inputTokens: result?.usage?.tokens,
    })
  }

  setTextGenerationTags (span, ctx) {
    const { event, result } = ctx

    const lastUserPrompt = event.messages.reverse().find(message => message.role === 'user').content
    const input = Array.isArray(lastUserPrompt) ? lastUserPrompt.map(part => part.text ?? '').join('') : lastUserPrompt

    let output
    if (ctx.isStream) {
      const outputContents = this.#outputContentsByCallId.get(event.callId)
      output = outputContents[outputContents.length - 1].find(part => part.type === 'text').text
    } else {
      output = result._output
    }

    this._tagger.tagTextIO(span, input, output)

    const metadata = getGenerationMetadataFromEvent(event)
    this._tagger.tagMetadata(span, metadata)
  }

  setStepTags (span, ctx) {
    const { result, event } = ctx

    let content
    if (ctx.isStream) {
      const outputContents = this.#outputContentsByCallId.get(event.callId)
      content = outputContents?.[outputContents.length - 1]
    } else {
      content = result?.content
    }

    // capture reasoning if applicable
    const reasoning = content?.find(part => part.type === 'reasoning')?.text
    if (reasoning) {
      this._tagger.tagTextIO(span, reasoning)
    }
  }

  setLanguageModelCallTags (span, ctx) {
    const { event, result } = ctx

    // input messages
    const { instructions, messages } = event
    const inputMessages = formatLanguageModelInputMessages(instructions, messages)

    // output messages
    const outputMessages = formatLanguageModelOutputMessages(result.content)

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)

    // tool definitions
    const { tools } = event
    if (Array.isArray(tools)) {
      this._tagger.tagToolDefinitions(
        span,
        tools.map(({ inputSchema, ...rest }) => ({
          ...rest,
          schema: {
            properties: inputSchema.properties,
            required: inputSchema.required,
            type: inputSchema.type,
          },
        }))
      )
    }

    // metadata
    const metadata = getGenerationMetadataFromEvent(event)
    this._tagger.tagMetadata(span, metadata)

    // metrics
    const { usage } = result
    this._tagger.tagMetrics(span, {
      inputTokens: usage?.inputTokens?.total,
      cacheWriteTokens: usage?.inputTokens?.cacheWrite ?? 0,
      cacheReadTokens: usage?.inputTokens?.cacheRead ?? 0,
      outputTokens: usage?.outputTokens?.total,
      reasoningOutputTokens: usage?.outputTokens?.reasoning ?? 0,
    })
  }

  setToolTags (span, ctx) {
    const { event, result } = ctx

    const { toolCall } = event
    if (!toolCall) return

    this._tagger.tagTextIO(span, toolCall.input, result?.output?.output)
  }
}

module.exports = VercelAiTelemetryPlugin
