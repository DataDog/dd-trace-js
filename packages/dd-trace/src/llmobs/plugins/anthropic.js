'use strict'

const LLMObsPlugin = require('./base')

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
      const chunks = ctx.chunks ?? (ctx.chunks = [])
      if (chunk) ctx.chunks.push(chunk)

      if (!done) return

      const response = { content: [] }

      for (const chunk of chunks) {
        switch (chunk.type) {
          case 'message_start': {
            const { message } = chunk
            if (!message) continue

            const { role, usage } = message
            if (role) response.role = role
            if (usage) response.usage = usage
            break
          }
          case 'content_block_start': {
            const contentBlock = chunk.content_block
            if (!contentBlock) continue

            const { type } = contentBlock
            if (type === 'text') {
              response.content.push({ type, text: contentBlock.text })
            } else if (type === 'tool_use') {
              response.content.push({ type, name: contentBlock.name, input: '', id: contentBlock.id })
            }
            break
          }
          case 'content_block_delta': {
            const { delta } = chunk
            if (!delta) continue

            const { text } = delta
            if (text) response.content[response.content.length - 1].text += text

            const partialJson = delta.partial_json
            if (partialJson && delta.type === 'input_json_delta') {
              response.content[response.content.length - 1].input += partialJson
            }
            break
          }
          case 'content_block_stop': {
            const type = response.content[response.content.length - 1].type
            if (type === 'tool_use') {
              const input = response.content[response.content.length - 1].input ?? '{}'
              response.content[response.content.length - 1].input = JSON.parse(input)
            }
            break
          }
          case 'message_delta': {
            const { delta } = chunk

            const finishReason = delta?.stop_reason
            if (finishReason) response.finish_reason = finishReason

            const { usage } = chunk
            if (usage) {
              const responseUsage = response.usage ?? (response.usage = { input_tokens: 0, output_tokens: 0 })
              responseUsage.output_tokens = usage.output_tokens

              const cacheCreationTokens = usage.cache_creation_input_tokens
              const cacheReadTokens = usage.cache_read_input_tokens
              if (cacheCreationTokens) responseUsage.cache_creation_input_tokens = cacheCreationTokens
              if (cacheReadTokens) responseUsage.cache_read_input_tokens = cacheReadTokens
            }

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
    const { options } = ctx
    const { model } = options

    return {
      kind: 'llm',
      modelName: model,
      modelProvider: 'anthropic'
    }
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
      messages.unshift({ content: system, role: 'system' })
    }

    for (const message of messages) {
      const { content, role } = message

      if (typeof content === 'string') {
        inputMessages.push({ content, role })
        continue
      }

      for (const block of content) {
        if (block.type === 'text') {
          inputMessages.push({ content: block.text, role })
        } else if (block.type === 'image') {
          inputMessages.push({ content: '([IMAGE DETECTED])', role })
        } else if (block.type === 'tool_use') {
          const { text, name, id, type } = block
          let input = block.input
          if (typeof input === 'string') {
            input = JSON.parse(input)
          }

          const toolCall = {
            name,
            arguments: input,
            toolId: id,
            type
          }

          inputMessages.push({ content: text ?? '', role, toolCalls: [toolCall] })
        } else if (block.type === 'tool_result') {
          const { content } = block
          const formattedContent = this.#formatAnthropicToolResultContent(content)
          const toolResult = {
            result: formattedContent,
            toolId: block.tool_use_id,
            type: 'tool_result'
          }

          inputMessages.push({ content: '', role, toolResults: [toolResult] })
        } else {
          inputMessages.push({ content: JSON.stringify(block), role })
        }
      }
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
      const { text } = block
      if (typeof text === 'string') {
        outputMessages.push({ content: text, role })
      } else if (block.type === 'tool_use') {
        let input = block.input
        if (typeof input === 'string') {
          input = JSON.parse(input)
        }

        const toolCall = {
          name: block.name,
          arguments: input,
          toolId: block.id,
          type: block.type
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
    if (!result) return

    const { usage } = result
    if (!usage) return

    const inputTokens = usage.input_tokens
    const outputTokens = usage.output_tokens
    const cacheWriteTokens = usage.cache_creation_input_tokens
    const cacheReadTokens = usage.cache_read_input_tokens

    const metrics = {}

    metrics.inputTokens =
      (inputTokens ?? 0) +
      (cacheWriteTokens ?? 0) +
      (cacheReadTokens ?? 0)

    if (outputTokens) metrics.outputTokens = outputTokens
    const totalTokens = metrics.inputTokens + (outputTokens ?? 0)
    if (totalTokens) metrics.totalTokens = totalTokens

    if (cacheWriteTokens != null) metrics.cacheWriteTokens = cacheWriteTokens
    if (cacheReadTokens != null) metrics.cacheReadTokens = cacheReadTokens

    this._tagger.tagMetrics(span, metrics)
  }

  // maybe can make into a util file
  #formatAnthropicToolResultContent (content) {
    if (typeof content === 'string') {
      return content
    } else if (Array.isArray(content)) {
      const formattedContent = []
      for (const toolResultBlock of content) {
        if (toolResultBlock.text) {
          formattedContent.push(toolResultBlock.text)
        } else if (toolResultBlock.type === 'image') {
          formattedContent.push('([IMAGE DETECTED])')
        }
      }

      return formattedContent.join(',')
    }
    return JSON.stringify(content)
  }
}

module.exports = AnthropicLLMObsPlugin
