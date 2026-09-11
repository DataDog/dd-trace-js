'use strict'

const { UNKNOWN_MODEL_PROVIDER } = require('../../constants/tags')
const { safeJsonParse } = require('../../util')
const LLMObsPlugin = require('../base')
const { appendMessage } = require('./util')

const ALLOWED_METADATA_KEYS = new Set([
  'max_tokens',
  'stop_sequences',
  'temperature',
  'top_k',
  'top_p',
])

class AnthropicLLMObsPlugin extends LLMObsPlugin {
  static integration = 'anthropic' // used for llmobs telemetry
  static id = 'anthropic'
  static prefix = 'tracing:apm:anthropic:request'

  constructor () {
    super(...arguments)

    this.addSub('apm:anthropic:request:chunk', ({ ctx, chunk, done }) => {
      if (!this._llmobsEnabled) {
        // only the token usage is needed, for the `gen_ai.usage.*` metrics; the message bodies
        // and the aggregated response are left to the LLMObs path
        if (chunk) ctx.streamedUsage = mergeChunkUsage(ctx.streamedUsage, chunk)
        return
      }

      ctx.chunks ??= []
      const chunks = ctx.chunks
      if (chunk) chunks.push(chunk)

      if (!done) return

      const response = { content: [] }

      for (const chunk of chunks) {
        switch (chunk.type) {
          case 'message_start': {
            const { message } = chunk
            if (!message) continue

            if (message.role) response.role = message.role
            response.usage = mergeChunkUsage(response.usage, chunk)
            break
          }
          case 'content_block_start': {
            const contentBlock = chunk.content_block
            if (!contentBlock) continue

            const { type } = contentBlock
            if (type === 'text') {
              response.content.push({ type, text: contentBlock.text })
            } else if (type === 'thinking') {
              response.content.push({ type, thinking: contentBlock.thinking ?? '' })
            } else if (type === 'tool_use') {
              response.content.push({ type, name: contentBlock.name, input: '', id: contentBlock.id })
            }
            break
          }
          case 'content_block_delta': {
            const { delta } = chunk
            if (!delta) continue

            const lastBlock = response.content.at(-1)
            if (!lastBlock) continue

            if (delta.type === 'thinking_delta') {
              const { thinking } = delta
              if (thinking) lastBlock.thinking += thinking
            } else if (delta.type === 'signature_delta') {
              // Signature is for internal verification only; skip it.
            } else if (delta.type === 'input_json_delta') {
              const partialJson = delta.partial_json
              if (partialJson) lastBlock.input += partialJson
            } else {
              const { text } = delta
              if (text) lastBlock.text += text
            }
            break
          }
          case 'content_block_stop': {
            const lastBlock = response.content.at(-1)
            if (!lastBlock) break
            if (lastBlock.type === 'tool_use') {
              const input = lastBlock.input ?? '{}'
              lastBlock.input = safeJsonParse(input, {})
            }
            break
          }
          case 'message_delta': {
            const finishReason = chunk.delta?.stop_reason
            if (finishReason) response.finish_reason = finishReason

            response.usage = mergeChunkUsage(response.usage, chunk)
            break
          }
          case 'error': {
            const { error } = chunk
            if (!error) continue

            response.error = {}
            if (error.type) response.error.type = error.type
            if (error.message) response.error.message = error.message

            break
          }
        }

        ctx.result = response
      }
    })
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const { options, baseUrl } = ctx
    const { model } = options
    const modelProvider = this._getModelProvider(baseUrl)

    return {
      kind: 'llm',
      modelName: model,
      modelProvider,
    }
  }

  _getModelProvider (baseUrl = '') {
    if (baseUrl.includes('anthropic')) {
      return 'anthropic'
    }
    return UNKNOWN_MODEL_PROVIDER
  }

  /**
   * @override
   */
  getGenAiApmEndTags (ctx) {
    return { metrics: extractUsage(ctx.result ?? { usage: ctx.streamedUsage }) }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { options, result } = ctx

    this.#tagAnthropicInputMessages(span, options)
    this.#tagAnthropicOutputMessages(span, result)
    this.#tagAnthropicMetadata(span, options)
    this.#tagAnthropicUsage(span, result)
  }

  #tagAnthropicInputMessages (span, options) {
    const { system, messages } = options
    const inputMessages = []

    if (system) {
      appendMessage(inputMessages, { role: 'system', content: system })
    }

    for (const message of messages) {
      appendMessage(inputMessages, message)
    }

    this._tagger.tagLLMIO(span, inputMessages)
  }

  #tagAnthropicOutputMessages (span, result) {
    if (!result) return

    const { content, role } = result

    if (typeof content === 'string') {
      this._tagger.tagLLMIO(span, null, [{ content, role }])
      return
    }

    const outputMessages = []
    for (const block of content) {
      if (block.type === 'thinking') {
        outputMessages.push({ content: block.thinking ?? '', role: 'reasoning' })
        continue
      }
      const { text } = block
      if (typeof text === 'string') {
        outputMessages.push({ content: text, role })
      } else if (block.type === 'tool_use') {
        const toolCall = {
          name: block.name,
          arguments: safeJsonParse(block.input, {}),
          toolId: block.id,
          type: block.type,
        }

        outputMessages.push({ content: text ?? '', role, toolCalls: [toolCall] })
      }
    }

    this._tagger.tagLLMIO(span, null, outputMessages)
  }

  #tagAnthropicMetadata (span, options) {
    const metadata = {}
    for (const [key, value] of Object.entries(options)) {
      if (ALLOWED_METADATA_KEYS.has(key)) {
        metadata[key] = value
      }
    }

    this._tagger.tagMetadata(span, metadata)
  }

  #tagAnthropicUsage (span, result) {
    const metrics = extractUsage(result)
    if (metrics) this._tagger.tagMetrics(span, metrics)
  }
}

/**
 * Merges the token usage a streamed chunk carries into the usage accumulated so far.
 *
 * @param {Record<string, number> | undefined} usage
 * @param {object} chunk
 * @returns {Record<string, number> | undefined}
 */
function mergeChunkUsage (usage, chunk) {
  if (chunk.type === 'message_start') return chunk.message?.usage ?? usage
  if (chunk.type !== 'message_delta' || !chunk.usage) return usage

  const mergedUsage = usage ?? { input_tokens: 0, output_tokens: 0 }
  mergedUsage.output_tokens = chunk.usage.output_tokens

  const cacheCreationTokens = chunk.usage.cache_creation_input_tokens
  const cacheReadTokens = chunk.usage.cache_read_input_tokens
  if (cacheCreationTokens) mergedUsage.cache_creation_input_tokens = cacheCreationTokens
  if (cacheReadTokens) mergedUsage.cache_read_input_tokens = cacheReadTokens

  return mergedUsage
}

/**
 * @param {object} [result]
 * @returns {Record<string, number> | undefined}
 */
function extractUsage (result) {
  const usage = result?.usage
  if (!usage) return

  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const cacheWriteTokens = usage.cache_creation_input_tokens
  const cacheReadTokens = usage.cache_read_input_tokens

  const metrics = {
    inputTokens: (inputTokens ?? 0) + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0),
  }

  if (outputTokens) metrics.outputTokens = outputTokens
  const totalTokens = metrics.inputTokens + (outputTokens ?? 0)
  if (totalTokens) metrics.totalTokens = totalTokens

  if (cacheWriteTokens != null) metrics.cacheWriteTokens = cacheWriteTokens
  if (cacheReadTokens != null) metrics.cacheReadTokens = cacheReadTokens

  const cacheCreation = usage.cache_creation
  if (cacheCreation) {
    metrics.cacheWrite5mTokens = cacheCreation.ephemeral_5m_input_tokens ?? 0
    metrics.cacheWrite1hTokens = cacheCreation.ephemeral_1h_input_tokens ?? 0
  } else if (cacheWriteTokens != null) {
    metrics.cacheWrite5mTokens = cacheWriteTokens
    metrics.cacheWrite1hTokens = 0
  }

  return metrics
}

module.exports = AnthropicLLMObsPlugin
