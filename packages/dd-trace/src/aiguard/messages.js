'use strict'

/**
 * Converts a LanguageModelV2FilePart with an image mediaType to an OpenAI image_url content part.
 *
 * @param {{type: 'file', data: URL|string|Uint8Array, mediaType: string}} part
 * @returns {{type: 'image_url', image_url: {url: string}}|undefined}
 */
function convertFilePartToImageUrl (part) {
  const { data, mediaType } = part

  if (data instanceof URL) {
    return { type: 'image_url', image_url: { url: data.toString() } }
  }

  if (typeof data === 'string') {
    if (data.startsWith('http') || data.startsWith('data:')) {
      return { type: 'image_url', image_url: { url: data } }
    }
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } }
  }

  if (data instanceof Uint8Array) {
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}` } }
  }
}

/**
 * Converts a LanguageModelV2Prompt to the OpenAI-style message format expected by AIGuard's evaluate API.
 *
 * Vercel AI v2 prompt entries use content arrays with typed parts (e.g. { type: 'text', text },
 * { type: 'file', data, mediaType }), while AIGuard expects OpenAI-style messages.
 * When file parts with image media types are present, the content is an array of text and
 * image_url parts; otherwise it is a plain string.
 *
 * @param {Array<{role: string, content: string|Array<{type: string}>}>} prompt
 * @returns {Array<{role: string, content?: string|Array<{type: string}>, tool_calls?: Array, tool_call_id?: string}>}
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
          const contentParts = []
          for (const part of msg.content) {
            if (part.type === 'text') {
              contentParts.push({ type: 'text', text: part.text })
            } else if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
              const converted = convertFilePartToImageUrl(part)
              if (converted) contentParts.push(converted)
            }
          }
          const hasImages = contentParts.some(p => p.type === 'image_url')
          if (hasImages) {
            messages.push({ role: 'user', content: contentParts })
          } else {
            messages.push({ role: 'user', content: contentParts.map(p => p.text).join('\n') })
          }
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
  convertFilePartToImageUrl, // test only
  buildToolCallOutputMessages, // test only
  buildTextOutputMessages, // test only
  buildOutputMessages,
}
