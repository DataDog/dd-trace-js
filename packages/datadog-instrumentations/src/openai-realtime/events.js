'use strict'

/**
 * @typedef {import('./turns').ToolCall} ToolCall
 * @typedef {import('./turns').ToolResult} ToolResult
 */

/**
 * Collapse SDK naming drift so `response.output_audio.*` / `response.output_text.*` match their
 * older `response.audio.*` / `response.text.*` equivalents.
 *
 * @param {string} eventType
 * @returns {string}
 */
function normalizeResponseEventType (eventType) {
  // Only `response.*` events carry the renamed segments, and they are a small fraction of the
  // stream, so skip the three replacements entirely for everything else.
  if (!eventType.startsWith('response.')) return eventType

  return eventType
    .replace('.output_audio_transcript', '.audio_transcript')
    .replace('.output_audio', '.audio')
    .replace('.output_text', '.text')
}

/**
 * Pull function and MCP tool usage out of a `response.done`'s output items.
 *
 * Function calls become tool calls — the app returns their result later via `function_call_output`,
 * captured on the next turn's input. MCP calls run server-side, so their result is inline on the
 * item and is captured as a tool result alongside the call.
 *
 * `arguments` is left as the raw JSON string the API sent; the LLM Observability plugin parses it,
 * so this stays a provider-native extraction.
 *
 * @param {{ output?: Array<Record<string, unknown>> }} response
 * @returns {{ toolCalls: ToolCall[], toolResults: ToolResult[] }}
 */
function extractResponseTools (response) {
  /** @type {ToolCall[]} */
  const toolCalls = []
  /** @type {ToolResult[]} */
  const toolResults = []

  const output = response?.output
  if (!output) return { toolCalls, toolResults }

  for (const item of output) {
    if (item?.type === 'function_call') {
      toolCalls.push({
        name: String(item.name ?? ''),
        arguments: item.arguments,
        toolId: String(item.call_id ?? item.id ?? ''),
        type: 'function',
      })
    } else if (item?.type === 'mcp_call') {
      const toolId = String(item.id ?? '')
      const name = String(item.name ?? '')

      toolCalls.push({ name, arguments: item.arguments, toolId, type: 'mcp_call' })

      const { output, error } = item
      if (output != null || error != null) {
        toolResults.push({
          name,
          result: String(output ?? error),
          toolId,
          type: 'mcp_tool_result',
        })
      }
    }
  }

  return { toolCalls, toolResults }
}

module.exports = { extractResponseTools, normalizeResponseEventType }
