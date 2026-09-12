'use strict'

const { safeJsonParse } = require('../../util')

/**
 * @typedef {{type: 'text', text: string}} TextBlock
 * @typedef {{type: 'image'}} ImageBlock
 * @typedef {{type: 'thinking', thinking: string, signature?: string}} ThinkingBlock
 * @typedef {{
 *  type: 'tool_use', text: string, name: string, id: string, input: string | Record<string, unknown>
 * }} ToolUseBlock
 * @typedef {{
 *  type: 'tool_result',
 *  tool_use_id: string,
 *  content: string | Array<{type: string, text?: string}>
 * }} ToolResultBlock
 *
 * @typedef {{
 *   content: string,
 *   role: string,
 *   toolCalls?: Array<{
 *     name: string,
 *     arguments: string | Record<string, unknown>,
 *     toolId: string,
 *     type: string
 *   }>,
 *   toolResults?: Array<{
 *     result: string,
 *     toolId: string,
 *     type: 'tool_result'
 *   }>
 * }} AnthropicLlmObsMessage
 */

/**
 * Formats tool result into LLM Observability compatible contents
 * @param {ToolResultBlock['content']} content
 */
function formatAnthropicToolResultContent (content) {
  if (typeof content === 'string') {
    return content
  } else if (Array.isArray(content)) {
    let formattedContent = ''
    for (const toolResultBlock of content) {
      if (!toolResultBlock || typeof toolResultBlock !== 'object') continue
      let part
      if (toolResultBlock.text) {
        part = toolResultBlock.text
      } else if (toolResultBlock.type === 'image') {
        part = '([IMAGE DETECTED])'
      }
      if (part === undefined) continue
      if (formattedContent) formattedContent += ','
      formattedContent += part
    }

    return formattedContent
  }
  return safeJsonStringify(content)
}

/**
 * Normalizes and formats a message into LLM Observability compatible contents.
 * Can be spread into a list of other messages.
 *
 * @param {AnthropicLlmObsMessage[]} messages
 * @param {{ role: string, content: string | Array<TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock> }} message
 * @returns {void}
 */
function appendMessage (messages, { role, content } = {}) {
  if (typeof content === 'string') {
    messages.push({ content, role })
    return
  }

  if (!Array.isArray(content)) {
    messages.push({ content: content == null ? '' : String(content), role })
    return
  }

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      messages.push({ content: block.text, role })
    } else if (block.type === 'image') {
      messages.push({ content: '([IMAGE DETECTED])', role })
    } else if (block.type === 'thinking') {
      messages.push({ content: block.thinking ?? '', role: 'reasoning' })
    } else if (typeof block.type === 'string' && block.type.includes('tool_use')) {
      const { text, name, id, type } = block
      let input = block.input
      if (typeof input === 'string') {
        input = safeJsonParse(input, {})
      }

      const toolCall = {
        name,
        arguments: input,
        toolId: id,
        type,
      }

      messages.push({ content: text ?? '', role, toolCalls: [toolCall] })
    } else if (typeof block.type === 'string' && block.type.includes('tool_result')) {
      const { content } = block
      const formattedContent = formatAnthropicToolResultContent(content)
      const toolResult = {
        result: formattedContent,
        toolId: block.tool_use_id,
        type: 'tool_result',
      }

      messages.push({ content: '', role, toolResults: [toolResult] })
    } else {
      messages.push({ content: safeJsonStringify(block), role })
    }
  }
}

function safeJsonStringify (value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function getAnthropicToolDefinitions (tools) {
  if (!Array.isArray(tools)) return []

  const definitions = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue

    const deferred = Boolean(tool.defer_loading)
    definitions.push({
      name: tool.name,
      description: deferred ? '' : (tool.description ?? ''),
      schema: deferred ? {} : (tool.input_schema ?? {}),
    })
  }
  return definitions
}

module.exports = {
  appendMessage,
  getAnthropicToolDefinitions,
}
