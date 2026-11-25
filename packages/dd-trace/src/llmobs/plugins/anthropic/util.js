'use strict'

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
  } else if (Array.isArray(content) && content.some(block => block?.type === 'web_search_result')) {
    // Search results carry no `text`; keep what identifies each page, never the `encrypted_content` payload.
    const sources = content.filter(block => block?.type === 'web_search_result')
    return JSON.stringify({ sources: sources.map(source => ({ url: source.url, title: source.title })) })
  } else if (Array.isArray(content)) {
    let formattedContent = ''
    for (const toolResultBlock of content) {
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
  return JSON.stringify(content)
}

/**
 * Normalizes and formats a message into LLM Observability compatible contents.
 * Can be spread into a list of other messages.
 *
 * @param {AnthropicLlmObsMessage[]} messages
 * @param {{ role: string, content: string | Array<TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock> }} message
 */
function appendMessage (messages, { role, content }) {
  if (typeof content === 'string') {
    messages.push({ content, role })
    return
  }

  for (const block of content) {
    if (block.type === 'text') {
      messages.push({ content: block.text, role })
    } else if (block.type === 'image') {
      messages.push({ content: '([IMAGE DETECTED])', role })
    } else if (block.type === 'thinking') {
      messages.push({ content: block.thinking ?? '', role: 'reasoning' })
    } else if (block.type?.includes('tool_use')) {
      // Also `server_tool_use` / `mcp_tool_use`, which share the `tool_use` shape.
      const { text, name, id, type } = block
      let input = block.input
      if (typeof input === 'string') {
        input = JSON.parse(input)
      }

      const toolCall = {
        name,
        arguments: input,
        toolId: id,
        type,
      }

      messages.push({ content: text ?? '', role, toolCalls: [toolCall] })
    } else if (block.type?.includes('tool_result')) {
      const { content } = block
      const formattedContent = formatAnthropicToolResultContent(content)
      const toolResult = {
        result: formattedContent,
        toolId: block.tool_use_id,
        type: 'tool_result',
      }

      messages.push({ content: '', role, toolResults: [toolResult] })
    } else {
      messages.push({ content: JSON.stringify(block), role })
    }
  }
}

module.exports = {
  appendMessage,
  formatAnthropicToolResultContent,
}
