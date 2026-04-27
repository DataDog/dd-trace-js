'use strict'

/**
 * @typedef {{type: 'text', text: string}} TextBlock
 * @typedef {{type: 'image'}} ImageBlock
 * @typedef {{
 *  type: 'tool_use', text: string, name: string, id: string, input: string | Record<string, unknown>
 * }} ToolUseBlock
 * @typedef {{
 *  type: 'tool_result',
 *  tool_use_id: string,
 *  content: string | Array<{type: string, text?: string}>
 * }} ToolResultBlock
 */

/**
 * Formats tool result into LLM Observability compatible contents
 * @param {ToolResultBlock['content']} content
 */
function formatAnthropicToolResultContent (content) {
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

/**
 * Normalizes and formats a message into LLM Observability compatible contents.
 * Can be spread into a list of other messages.
 *
 * @param {string} role
 * @param {string | Array<TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock>} content
 * @returns {Array}
 */
function formatMessage (role, content) {
  if (typeof content === 'string') {
    return [{ content, role }]
  }

  const messages = []

  for (const block of content) {
    if (block.type === 'text') {
      messages.push({ content: block.text, role })
    } else if (block.type === 'image') {
      messages.push({ content: '([IMAGE DETECTED])', role })
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
        type,
      }

      messages.push({ content: text ?? '', role, toolCalls: [toolCall] })
    } else if (block.type === 'tool_result') {
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

  return messages
}

module.exports = {
  formatMessage,
}
