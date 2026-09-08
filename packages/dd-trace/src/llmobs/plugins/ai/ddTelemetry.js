'use strict'

const { channel } = require('dc-polyfill')
const BaseLLMObsPlugin = require('../base')
const { getModelProvider } = require('../../../../../datadog-plugin-ai/src/utils')

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
  formatProviderToolResult,
  formatToolApprovalResponse,
  getLlmObsSpanName,
  getTelemetryMetadata,
} = require('./util')

/**
 * @typedef {string | number | boolean | null | undefined | string[] | number[] | boolean[]} TagValue
 * @typedef {Record<string, TagValue>} SpanTags
 *
 * @typedef {{ type: 'text' | 'reasoning' | 'redacted-reasoning', text?: string, data?: string }} TextPart
 * @typedef {{ type: 'tool-call', toolName: string, toolCallId: string, args?: unknown, input?: unknown }} ToolCallPart
 * @typedef {(
 *   { type: 'tool-result', toolCallId: string, output?: { type: string, value?: unknown }, result?: unknown } &
 *   Record<string, unknown>
 * )} ToolResultPart
 *
 * @typedef {{
 *   role: 'system',
 *   content: string
 * } | {
 *   role: 'user',
 *   content: TextPart[]
 * } | {
 *   role: 'assistant',
 *   content: Array<TextPart | ToolCallPart>
 * } | {
 *   role: 'tool',
 *   content: ToolResultPart[]
 * }} AiSdkMessage
 */

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
  toolCall: 'tool',
}

class DdTelemetryPlugin extends BaseLLMObsPlugin {
  static id = 'ai_llmobs_dd_telemetry'
  static integration = 'ai'
  static prefix = 'tracing:dd-trace:vercel-ai'

  constructor (...args) {
    super(...args)

    setAttributesCh.subscribe(({ ctx, attributes }) => {
      Object.assign(ctx.attributes, attributes)
    })
  }

  /**
   * @override
   */
  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const operation = getOperation(span)
    const kind = SPAN_NAME_TO_KIND_MAPPING[operation]
    if (!kind) return

    return { kind, name: getLlmObsSpanName(operation, ctx.attributes['ai.telemetry.functionId']) }
  }

  /**
   * @override
   */
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

    const metadata = getTelemetryMetadata(tags)
    this._tagger.tagMetadata(span, metadata)

    const usage = tags['ai.usage.tokens']
    this._tagger.tagMetrics(span, {
      inputTokens: usage,
      totalTokens: usage,
    })
  }

  setObjectGenerationTags (span, tags) {
    const promptInfo = getJsonStringValue(tags['ai.prompt'], {})
    const lastUserPrompt =
      promptInfo.prompt ??
      promptInfo.messages.reverse().find(message => message.role === 'user')?.content
    let prompt = lastUserPrompt
    if (Array.isArray(lastUserPrompt)) {
      prompt = ''
      for (const part of lastUserPrompt) {
        if (typeof part.text === 'string') prompt += part.text
      }
    }

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
    let prompt = lastUserPrompt
    if (Array.isArray(lastUserPrompt)) {
      prompt = ''
      for (const part of lastUserPrompt) {
        if (typeof part.text === 'string') prompt += part.text
      }
    }

    const output = tags['ai.response.text']

    this._tagger.tagTextIO(span, prompt, output)

    const metadata = getGenerationMetadata(tags)
    this._tagger.tagMetadata(span, metadata)
  }

  /**
   * @param {import('../../../opentracing/span')} span
   * @param {SpanTags} tags
   */
  setLLMOperationTags (span, tags) {
    const inputMessages = getJsonStringValue(tags['ai.prompt.messages'], [])
    const parsedInputMessages = []
    /** @type {Map<string, string>} */
    const toolCallIdsByApprovalId = new Map()
    for (const message of inputMessages) {
      const formattedMessages = this.formatMessage(message, toolCallIdsByApprovalId)
      parsedInputMessages.push(...formattedMessages)
    }

    const outputMessages = this.formatOutputMessages(tags)

    this._tagger.tagLLMIO(span, parsedInputMessages, outputMessages)

    const metadata = getModelMetadata(tags)
    this._tagger.tagMetadata(span, metadata)

    const usage = getUsage(tags)
    this._tagger.tagMetrics(span, usage)
  }

  setToolTags (span, tags) {
    const name = getToolNameFromTags(tags)

    if (name) this._tagger._setTag(span, NAME, name)

    const input = tags['ai.toolCall.args']
    const output = tags['ai.toolCall.result']

    this._tagger.tagTextIO(span, input, output)
  }

  /**
   * @param {SpanTags} tags
   * @returns {Array<{role: string, content?: string,
   *   toolCalls?: Array<{arguments: unknown, name: string, toolId: string, type: string}>}>}
   */
  formatOutputMessages (tags) {
    const outputMessages = []

    const reasoning = tags['ai.response.reasoning']
    if (typeof reasoning === 'string' && reasoning) {
      outputMessages.push({ role: 'reasoning', content: reasoning })
    }

    const outputMessageText = tags['ai.response.text'] ?? tags['ai.response.object']
    const outputMessageToolCalls = getJsonStringValue(tags['ai.response.toolCalls'], [])

    const formattedToolCalls = []
    for (const toolCall of outputMessageToolCalls) {
      const toolArgs = toolCall.args ?? toolCall.input
      const toolCallArgs = typeof toolArgs === 'string' ? getJsonStringValue(toolArgs, {}) : toolArgs
      formattedToolCalls.push({
        arguments: toolCallArgs,
        name: toolCall.toolName,
        toolId: toolCall.toolCallId,
        type: toolCall.toolCallType ?? 'function',
      })
    }

    outputMessages.push({
      role: 'assistant',
      content: outputMessageText,
      toolCalls: formattedToolCalls,
    })

    return outputMessages
  }

  /**
   * Returns a list of formatted messages from a message object.
   * Most of these will just be one entry, but in the case of a "tool" role,
   * it is possible to have multiple tool call results in a single message that we
   * need to split into multiple messages.
   *
   * @param {AiSdkMessage} message
   * @param {Map<string, string>} toolCallIdsByApprovalId approval IDs seen on prior assistant messages,
   *   used to link tool approval responses back to their tool call
   * @returns {Array<{role: string, content?: string, toolId?: string,
   *   toolCalls?: Array<{arguments: unknown, name: string, toolId: string, type: string}>,
   *   toolResults?: Array<{result: string, name: string, toolId: string, type: string}>}>}
   */
  formatMessage (message, toolCallIdsByApprovalId = new Map()) {
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
      if (typeof content === 'string') {
        return [{ role, content }]
      }

      const toolCalls = []
      const toolResults = []
      let finalContent = ''
      let reasoningContent = ''

      for (const part of content) {
        const { type } = part
        if (type === 'text') {
          finalContent += part.text
        } else if (type === 'reasoning' || type === 'redacted-reasoning') {
          reasoningContent += part.text ?? part.data ?? ''
        } else if (type === 'tool-call') {
          toolCalls.push({
            arguments: part.args ?? part.input,
            name: part.toolName,
            toolId: part.toolCallId,
            type: 'function',
          })
        } else if (type === 'tool-result') {
          // provider-executed tool results are returned inline with the assistant content
          toolResults.push(formatProviderToolResult(part))
        } else if (type === 'tool-approval-request' && part.approvalId && part.toolCallId) {
          toolCallIdsByApprovalId.set(part.approvalId, part.toolCallId)
        }
      }

      const finalMessages = []

      if (reasoningContent) {
        finalMessages.push({ role: 'reasoning', content: reasoningContent })
      }

      const finalMessage = {
        role,
        content: finalContent,
      }

      if (toolCalls.length) {
        finalMessage.toolCalls = toolCalls
      }

      if (toolResults.length) {
        finalMessage.toolResults = toolResults
      }

      finalMessages.push(finalMessage)

      return finalMessages
    } else if (role === 'tool') {
      const finalMessages = []
      for (const part of content) {
        if (part.type === 'tool-result') {
          const safeResult = getToolCallResultContent(part)

          finalMessages.push({
            role,
            content: safeResult,
            toolId: part.toolCallId,
          })
        } else if (part.type === 'tool-approval-response') {
          finalMessages.push(formatToolApprovalResponse(part, toolCallIdsByApprovalId))
        }
      }

      return finalMessages
    }

    return []
  }
}

module.exports = DdTelemetryPlugin
