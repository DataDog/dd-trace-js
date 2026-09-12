'use strict'

const { UNKNOWN_MODEL_PROVIDER } = require('../../constants/tags')
const { safeJsonParse } = require('../../util')

/**
 * Mirrors dd-trace-py `extract_provider`: an empty server URL means the SDK default (Mistral).
 *
 * @param {string} [serverURL]
 * @returns {string}
 */
function getModelProvider (serverURL = '') {
  return !serverURL || serverURL.toLowerCase().includes('mistral') ? 'mistral' : UNKNOWN_MODEL_PROVIDER
}

/**
 * Extracts the reasoning text of a `thinking` content chunk, or `undefined` for other chunk kinds.
 *
 * @param {object} chunk
 * @returns {string|undefined}
 */
function extractThinkingText (chunk) {
  const thinking = chunk?.thinking
  if (!Array.isArray(thinking)) return

  let text = ''
  for (const nested of thinking) {
    if (typeof nested?.text === 'string') text += nested.text
  }
  return text
}

/**
 * @param {Array<object>} rawToolCalls SDK tool calls (`{ id, function: { name, arguments } }`)
 * @returns {Array<{ name: string, arguments: object|string, toolId: string, type: string }>}
 */
function extractToolCalls (rawToolCalls) {
  const toolCalls = []
  for (const toolCall of rawToolCalls) {
    const fn = toolCall?.function
    const args = fn?.arguments ?? {}
    toolCalls.push({
      name: String(fn?.name ?? ''),
      arguments: typeof args === 'string' ? safeJsonParse(args) : args,
      toolId: String(toolCall?.id ?? ''),
      type: 'function',
    })
  }
  return toolCalls
}

/**
 * @param {Array<object>} [messages] request messages
 * @returns {Array<object>} LLMObs input messages
 */
function extractInputMessages (messages) {
  const inputMessages = []
  if (!Array.isArray(messages)) return inputMessages

  for (const message of messages) {
    const role = message?.role ?? ''
    const content = message?.content

    if (Array.isArray(content)) {
      for (const chunk of content) {
        const thinkingText = extractThinkingText(chunk)
        if (thinkingText === undefined) {
          inputMessages.push({ content: String(chunk?.text ?? ''), role })
        } else {
          inputMessages.push({ content: thinkingText, role: 'reasoning' })
        }
      }
      continue
    }

    const inputMessage = { content: content == null ? '' : String(content), role }
    const toolCalls = message?.toolCalls ?? message?.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      inputMessage.toolCalls = extractToolCalls(toolCalls)
    }
    inputMessages.push(inputMessage)
  }

  return inputMessages
}

/**
 * Splits an assistant message into an optional `reasoning` message followed by the assistant message.
 *
 * @param {object} message
 * @returns {Array<object>}
 */
function extractMessagesFromAssistantMessage (message) {
  const role = String(message?.role || 'assistant')
  const content = message?.content ?? ''

  let reasoning = ''
  let text = ''
  if (Array.isArray(content)) {
    for (const chunk of content) {
      const thinkingText = extractThinkingText(chunk)
      if (thinkingText === undefined) {
        if (typeof chunk?.text === 'string') text += chunk.text
      } else {
        reasoning += thinkingText
      }
    }
  } else {
    text = String(content || '')
  }

  const messages = []
  if (reasoning) messages.push({ content: reasoning, role: 'reasoning' })

  const outputMessage = { content: text, role }
  const toolCalls = message?.toolCalls ?? message?.tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    outputMessage.toolCalls = extractToolCalls(toolCalls)
  }
  messages.push(outputMessage)

  return messages
}

/**
 * @param {object} [response] chat completion response (or aggregated stream)
 * @returns {Array<object>} LLMObs output messages
 */
function extractOutputMessages (response) {
  const outputMessages = []
  const choices = response?.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message = choice?.message
      if (message == null) continue
      outputMessages.push(...extractMessagesFromAssistantMessage(message))
    }
  }

  return outputMessages.length > 0 ? outputMessages : [{ content: '', role: 'assistant' }]
}

/**
 * @param {Array<object>} [tools] request tools (`{ type: 'function', function: { name, description, parameters } }`)
 * @returns {Array<{ name: string, description: string, schema: object }>|undefined}
 */
function extractToolDefinitions (tools) {
  if (!Array.isArray(tools) || tools.length === 0) return

  const toolDefinitions = []
  for (const tool of tools) {
    const fn = tool?.function ?? tool
    toolDefinitions.push({
      name: String(fn?.name ?? ''),
      description: String(fn?.description ?? ''),
      schema: fn?.parameters ?? {},
    })
  }
  return toolDefinitions
}

/**
 * @param {object} [response]
 * @returns {Record<string, number>}
 */
function extractMetrics (response) {
  const usage = response?.usage
  /** @type {Record<string, number>} */
  const metrics = {}
  if (usage == null) return metrics

  const inputTokens = usage.promptTokens ?? usage.prompt_tokens
  const outputTokens = usage.completionTokens ?? usage.completion_tokens
  const totalTokens = usage.totalTokens ?? usage.total_tokens
  const cachedTokens = usage.numCachedTokens ?? usage.num_cached_tokens

  if (inputTokens != null) metrics.inputTokens = inputTokens
  if (outputTokens != null) metrics.outputTokens = outputTokens
  if (totalTokens != null) metrics.totalTokens = totalTokens
  if (cachedTokens != null) metrics.cacheReadTokens = cachedTokens

  return metrics
}

/**
 * Accumulates fragmented streamed tool calls by their `index`.
 *
 * @param {Map<number, object>} toolCallsMap
 * @param {Array<object>} toolCalls
 */
function accumulateToolCalls (toolCallsMap, toolCalls) {
  for (const toolCall of toolCalls) {
    const index = toolCall?.index ?? 0

    let accumulated = toolCallsMap.get(index)
    if (!accumulated) {
      accumulated = { id: '', function: { name: '', arguments: '' } }
      toolCallsMap.set(index, accumulated)
    }

    const toolId = toolCall?.id
    if (toolId != null && toolId !== 'null') accumulated.id = toolId

    const fn = toolCall?.function
    if (fn == null) continue

    if (fn.name && !accumulated.function.name) accumulated.function.name = fn.name
    const args = fn.arguments
    if (args) {
      accumulated.function.arguments += typeof args === 'string' ? args : JSON.stringify(args)
    }
  }
}

/**
 * Mirrors dd-trace-py `_join_chunks`: merges streamed `CompletionEvent`s into a chat-completion-like response.
 *
 * @param {Array<object>} chunks
 * @returns {object|undefined}
 */
function joinChunks (chunks) {
  if (chunks.length === 0) return

  /** @type {Map<number, { text: string, thinking: string, toolCallsMap: Map<number, object>, role?: string }>} */
  const choiceStates = new Map()
  let usage

  for (const event of chunks) {
    const chunk = event?.data ?? event
    usage ??= chunk?.usage ?? undefined

    const choices = chunk?.choices
    if (!Array.isArray(choices)) continue

    for (const choice of choices) {
      const delta = choice?.delta
      if (delta == null) continue

      const index = choice.index ?? 0
      let state = choiceStates.get(index)
      if (!state) {
        state = { text: '', thinking: '', toolCallsMap: new Map() }
        choiceStates.set(index, state)
      }

      if (typeof delta.role === 'string') state.role = delta.role

      const content = delta.content
      if (typeof content === 'string') {
        state.text += content
      } else if (Array.isArray(content)) {
        for (const contentChunk of content) {
          const thinkingText = extractThinkingText(contentChunk)
          if (thinkingText === undefined) {
            if (typeof contentChunk?.text === 'string') state.text += contentChunk.text
          } else {
            state.thinking += thinkingText
          }
        }
      }

      const toolCalls = delta.toolCalls ?? delta.tool_calls
      if (Array.isArray(toolCalls)) accumulateToolCalls(state.toolCallsMap, toolCalls)
    }
  }

  const choices = []
  for (const [, state] of [...choiceStates].sort(([a], [b]) => a - b)) {
    if (state.thinking) {
      choices.push({ message: { role: 'reasoning', content: state.thinking } })
    }
    const message = { role: state.role ?? 'assistant', content: state.text }
    if (state.toolCallsMap.size > 0) {
      message.toolCalls = [...state.toolCallsMap.values()]
    }
    choices.push({ message })
  }

  const response = { choices }
  if (usage != null) response.usage = usage
  return response
}

module.exports = {
  extractInputMessages,
  extractMetrics,
  extractOutputMessages,
  extractToolDefinitions,
  getModelProvider,
  joinChunks,
}
