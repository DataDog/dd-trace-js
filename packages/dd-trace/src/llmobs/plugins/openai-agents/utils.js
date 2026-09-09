'use strict'

const { extractContentParts, extractTextFromContentItem } = require('../openai/utils')
const { safeJsonParse } = require('../../util')

/**
 * Flatten Responses and Chat Completions content parts without dropping
 * provider-specific image or audio inputs.
 *
 * @param {Array<object>} parts
 * @returns {{ content: string, audioParts: Array<{ mimeType: string, content: string }> }}
 */
function extractMessageContent (parts) {
  let content = ''
  const audioParts = []

  for (const part of parts) {
    if (!part) continue
    const text = extractTextFromContentItem(part)
    if (text) {
      content += text
      continue
    }

    const extracted = extractContentParts([part])
    if (extracted.content) content += extracted.content
    if (extracted.audioParts.length > 0) audioParts.push(...extracted.audioParts)
  }

  return { content, audioParts }
}

/**
 * Normalize OpenAI Chat Completions tool calls to the LLMObs message schema.
 *
 * @param {object} message
 * @returns {Array<{ toolId?: string, name?: string, arguments: object, type?: string }>}
 */
function extractChatCompletionToolCalls (message) {
  if (message.function_call) {
    return [{
      name: message.function_call.name,
      arguments: safeJsonParse(message.function_call.arguments, {}),
      type: 'function',
    }]
  }

  const toolCalls = []
  if (!Array.isArray(message.tool_calls)) return toolCalls

  for (const toolCall of message.tool_calls) {
    if (!toolCall) continue
    toolCalls.push({
      toolId: toolCall.id,
      name: toolCall.function?.name,
      arguments: safeJsonParse(toolCall.function?.arguments, {}),
      type: toolCall.type,
    })
  }
  return toolCalls
}

/**
 * Normalize a Chat Completions message to the LLMObs message schema.
 *
 * @param {object} message
 * @returns {object}
 */
function normalizeChatCompletionMessage (message) {
  const normalized = {
    role: message.role || 'assistant',
    content: message.content ?? '',
  }
  if (message.audioParts?.length > 0) normalized.audioParts = message.audioParts
  const toolCalls = extractChatCompletionToolCalls(message)
  if (toolCalls.length > 0) normalized.toolCalls = toolCalls
  if (message.tool_call_id) normalized.toolId = message.tool_call_id
  return normalized
}

/**
 * Extracts input messages for an LLM span. agents-openai stores only
 * `request.input` on `spanData._input` (string or message-array), and the
 * system instructions are echoed back on the response as `instructions`.
 *
 * @param {string|Array<unknown>} input - The raw `request.input` (`spanData._input`).
 * @param {string} [instructions] - System instructions echoed on `response.instructions`.
 * @returns {Array<{ role: string, content: string }>}
 */
function extractInputMessages (input, instructions) {
  const messages = []

  if (instructions) {
    messages.push({ role: 'system', content: instructions })
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue
      if (item.type === 'message' || item.role) {
        const role = item.role
        if (!role) continue

        let content = ''
        let audioParts
        if (Array.isArray(item.content)) {
          const extracted = extractMessageContent(item.content)
          content = extracted.content
          audioParts = extracted.audioParts
        } else if (typeof item.content === 'string') {
          content = item.content
        }

        const message = normalizeChatCompletionMessage({ ...item, content, role, audioParts })
        if (content || message.audioParts || message.toolCalls || message.toolId) {
          messages.push(message)
        }
      } else if (item.type === 'function_call') {
        let args = item.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = {}
          }
        }
        messages.push({
          role: 'assistant',
          toolCalls: [{
            toolId: item.call_id,
            name: item.name,
            arguments: args,
            type: item.type,
          }],
        })
      } else if (item.type === 'function_call_output') {
        messages.push({
          role: 'user',
          toolResults: [{
            toolId: item.call_id,
            result: item.output,
            name: item.name || '',
            type: item.type,
          }],
        })
      }
    }
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

/**
 * Extracts output messages from the model response.
 *
 * @param {{ output?: Array<unknown> }} result - The model response
 * @returns {Array<{ role: string, content: string }>}
 */
function extractOutputMessages (result) {
  const messages = []

  if (result?.output) {
    for (const item of result.output) {
      if (!item) continue
      if (item.type === 'message') {
        let content = ''
        if (Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if (contentItem?.type === 'output_text' && contentItem.text) {
              content += contentItem.text
            }
          }
        } else if (typeof item.content === 'string') {
          content = item.content
        }

        messages.push({ role: item.role || 'assistant', content })
      } else if (item.type === 'function_call') {
        let args = item.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = {}
          }
        }
        messages.push({
          role: 'assistant',
          toolCalls: [{
            toolId: item.call_id,
            name: item.name,
            arguments: args,
            type: item.type,
          }],
        })
      }
    }
  }

  return messages.length > 0 ? messages : [{ content: '', role: '' }]
}

/**
 * Extracts output messages from an OpenAI Chat Completions response.
 *
 * @param {Array<{ choices?: Array<{ message?: object }> }>} result - The model responses
 * @returns {Array<object>}
 */
function extractGenerationOutputMessages (result) {
  const messages = []

  if (Array.isArray(result)) {
    for (const response of result) {
      if (!Array.isArray(response?.choices)) continue
      for (const choice of response.choices) {
        const message = choice?.message
        if (!message) continue
        messages.push(normalizeChatCompletionMessage(message))
      }
    }
  }

  return messages.length > 0 ? messages : [{ content: '', role: '' }]
}

/**
 * Extracts token usage metrics from the model response. Returns `undefined`
 * when there's nothing to tag, so callers can skip the tagger call without
 * allocating an Object.keys array.
 *
 * @param {{ usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number,
 *   outputTokensDetails?: { reasoningTokens?: number },
 *   completion_tokens_details?: { reasoning_tokens?: number } } }} result
 * @returns {{ inputTokens?: number, outputTokens?: number, totalTokens?: number,
 *   reasoningOutputTokens?: number } | undefined}
 */
function extractMetrics (result) {
  const usage = result?.usage
  if (!usage) return

  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens
  const totalTokens = usage.totalTokens ?? usage.total_tokens
  const reasoningTokens = usage.outputTokensDetails?.reasoningTokens ??
    usage.output_tokens_details?.reasoning_tokens ??
    usage.completion_tokens_details?.reasoning_tokens

  if (inputTokens === undefined && outputTokens === undefined &&
      totalTokens === undefined && !reasoningTokens) return

  const metrics = {}
  if (inputTokens !== undefined) metrics.inputTokens = inputTokens
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens
  // Tagger maps `reasoningOutputTokens` → `reasoning_output_tokens` in the
  // LLMObs span event. Skip when zero — emitting a zero just adds noise.
  if (reasoningTokens) metrics.reasoningOutputTokens = reasoningTokens

  if (totalTokens !== undefined) {
    metrics.totalTokens = totalTokens
  } else if (metrics.inputTokens !== undefined && metrics.outputTokens !== undefined) {
    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens
  }

  return metrics
}

// Fields the OpenAI Responses API echoes back from the request configuration.
// agents-openai only stores `request.input` on the span — the user's
// `modelSettings` aren't directly observable, so we read the response-echoed
// values. Matches dd-trace-py's openai-agents integration (see
// `OaiSpanAdapter.llmobs_metadata`); both ship without filtering OpenAI's
// default values.
const RESPONSE_METADATA_FIELDS = [
  'temperature',
  'max_output_tokens',
  'top_p',
  'tools',
  'tool_choice',
  'truncation',
]

/**
 * Extracts metadata from the model response. Mirrors Python's
 * `OaiSpanAdapter.llmobs_metadata` — emits all response-echoed configuration
 * fields plus `text` when present. Returns `undefined` when nothing was
 * captured, so callers can skip the tagger call without allocating.
 *
 * @param {object | undefined} response
 * @returns {object | undefined}
 */
function extractMetadata (response) {
  if (!response) return

  let metadata
  for (const field of RESPONSE_METADATA_FIELDS) {
    const value = response[field]
    if (value !== undefined && value !== null) {
      metadata ??= {}
      metadata[field] = value
    }
  }

  if (response.text) {
    metadata ??= {}
    metadata.text = response.text
  }

  return metadata
}

module.exports = {
  extractInputMessages,
  extractOutputMessages,
  extractGenerationOutputMessages,
  extractMetrics,
  extractMetadata,
}
