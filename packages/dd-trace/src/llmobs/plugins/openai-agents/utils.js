'use strict'

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
      if (item.type === 'message') {
        const role = item.role
        if (!role) continue

        let content = ''
        if (Array.isArray(item.content)) {
          const textParts = item.content
            .filter(c => c.type === 'input_text' || c.type === 'text')
            .map(c => c.text)
          content = textParts.join('')
        } else if (typeof item.content === 'string') {
          content = item.content
        }

        if (content) {
          messages.push({ role, content })
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
  if (!result?.output) return [{ content: '', role: '' }]

  const messages = []

  for (const item of result.output) {
    if (item.type === 'message') {
      let content = ''
      if (Array.isArray(item.content)) {
        const textParts = item.content
          .filter(c => c.type === 'output_text')
          .map(c => c.text)
        content = textParts.join('')
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

  return messages.length > 0 ? messages : [{ content: '', role: '' }]
}

/**
 * Extracts token usage metrics from the model response.
 *
 * @param {{ usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number,
 *   outputTokensDetails?: { reasoningTokens?: number } } }} result
 * @returns {{ inputTokens?: number, outputTokens?: number, totalTokens?: number, reasoningTokens?: number }}
 */
function extractMetrics (result) {
  const metrics = {}
  const usage = result?.usage
  if (!usage) return metrics

  const inputTokens = usage.inputTokens ?? usage.input_tokens
  const outputTokens = usage.outputTokens ?? usage.output_tokens
  const totalTokens = usage.totalTokens ?? usage.total_tokens
  const reasoningTokens = usage.outputTokensDetails?.reasoningTokens ??
    usage.output_tokens_details?.reasoning_tokens

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
 * fields plus `text` when present.
 *
 * @param {object | undefined} response
 * @returns {object}
 */
function extractMetadata (response) {
  const metadata = {}
  if (!response) return metadata

  for (const field of RESPONSE_METADATA_FIELDS) {
    const value = response[field]
    if (value !== undefined && value !== null) {
      metadata[field] = value
    }
  }

  if (response.text) {
    metadata.text = response.text
  }

  return metadata
}

module.exports = {
  extractInputMessages,
  extractOutputMessages,
  extractMetrics,
  extractMetadata,
}
