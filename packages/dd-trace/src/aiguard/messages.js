'use strict'

/**
 * Converts Vercel AI SDK internal prompt format to the OpenAI-style message format
 * expected by AIGuard's evaluate API.
 *
 * Vercel AI prompt entries use content arrays with typed parts (e.g. { type: 'text', text }),
 * while AIGuard expects flat { role, content } messages.
 *
 * @param {Array<{role: string, content: string|Array<{type: string}>}>} prompt
 * @returns {Array<{role: string, content?: string, tool_calls?: Array, tool_call_id?: string}>}
 */
function convertVercelPromptToMessages (prompt) {
  if (!Array.isArray(prompt)) return []

  const messages = []
  for (const msg of prompt) {
    switch (msg.role) {
      case 'system':
        messages.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : '' })
        break

      case 'user': {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content })
        } else if (Array.isArray(msg.content)) {
          const textParts = []
          for (const part of msg.content) {
            if (part.type === 'text') textParts.push(part.text)
          }
          messages.push({ role: 'user', content: textParts.join('\n') })
        }
        break
      }

      case 'assistant': {
        const textParts = []
        const toolCalls = []
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              textParts.push(part.text)
            } else if (part.type === 'tool-call') {
              toolCalls.push({
                id: part.toolCallId,
                function: {
                  name: part.toolName,
                  arguments: typeof part.args === 'string' ? part.args : JSON.stringify(part.args),
                },
              })
            }
          }
        }
        if (toolCalls.length > 0) {
          messages.push({ role: 'assistant', tool_calls: toolCalls })
        } else {
          messages.push({ role: 'assistant', content: textParts.join('\n') })
        }
        break
      }

      case 'tool': {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'tool-result') {
              messages.push({
                role: 'tool',
                tool_call_id: part.toolCallId,
                content: typeof part.result === 'string' ? part.result : JSON.stringify(part.result),
              })
            }
          }
        }
        break
      }
    }
  }
  return messages
}

/**
 * Converts LLM output tool calls to AIGuard message format for output evaluation.
 *
 * @param {Array<object>} inputMessages - The input messages already in AIGuard format
 * @param {Array<{toolCallId: string, toolName: string, args?: unknown, input?: unknown}>} toolCalls
 * @returns {Array<object>}
 */
function buildToolCallOutputMessages (inputMessages, toolCalls) {
  return [
    ...inputMessages,
    {
      role: 'assistant',
      tool_calls: toolCalls.map(tc => {
        const args = tc.args ?? tc.input
        return {
          id: tc.toolCallId,
          function: {
            name: tc.toolName,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          },
        }
      }),
    },
  ]
}

/**
 * Builds AIGuard output messages for evaluating the assistant's text response.
 *
 * @param {Array<object>} inputMessages - The input messages already in AIGuard format
 * @param {string} text - The assistant's text response
 * @returns {Array<object>}
 */
function buildTextOutputMessages (inputMessages, text) {
  return [
    ...inputMessages,
    { role: 'assistant', content: text },
  ]
}

/**
 * Parses content array and dispatches to the appropriate output message builder.
 *
 * @param {Array<object>} inputMessages - The input messages already in AIGuard format
 * @param {Array<{type: string}>} content - content array
 * @returns {Array<object>}
 */
function buildOutputMessages (inputMessages, content) {
  const toolCalls = content.filter(c => c.type === 'tool-call')
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  if (toolCalls.length) return buildToolCallOutputMessages(inputMessages, toolCalls)
  if (text) return buildTextOutputMessages(inputMessages, text)
  return inputMessages
}

module.exports = {
  convertVercelPromptToMessages,
  buildToolCallOutputMessages, // test only
  buildTextOutputMessages, // test only
  buildOutputMessages,
}
