'use strict'

/**
 * Returns the value as a string, JSON-stringifying it when it is not already a string.
 * Returns the value unchanged when it is `null` or `undefined`.
 *
 * @param {unknown} value
 * @returns {string|undefined|null}
 */
function stringifyIfNeeded (value) {
  if (value == null) return value
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Converts a LanguageModelV2FilePart with an image mediaType to an AI Guard style image_url content part.
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
 * Converts a LanguageModelV2Prompt to the AI Guard style message format.
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
        if (!Array.isArray(msg.content)) break

        const contentParts = []
        for (const part of msg.content) {
          if (part.type === 'text') {
            contentParts.push({ type: 'text', text: part.text })
          } else if (part.type === 'file' && part.mediaType?.startsWith('image/')) {
            const converted = convertFilePartToImageUrl(part)
            if (converted) contentParts.push(converted)
          }
        }

        if (contentParts.length === 0) break

        const hasImages = contentParts.some(p => p.type === 'image_url')
        if (hasImages) {
          messages.push({ role: 'user', content: contentParts })
        } else {
          messages.push({ role: 'user', content: contentParts.map(p => p.text).join('\n') })
        }
        break
      }

      case 'assistant': {
        const textParts = []
        const toolCalls = []
        if (!Array.isArray(msg.content)) break

        for (const part of msg.content) {
          if (part.type === 'text') {
            textParts.push(part.text)
          } else if (part.type === 'tool-call') {
            toolCalls.push({
              id: part.toolCallId,
              function: {
                name: part.toolName,
                arguments: stringifyIfNeeded(part.args ?? part.input),
              },
            })
          }
        }

        if (toolCalls.length > 0) {
          messages.push({ role: 'assistant', tool_calls: toolCalls })
        } else if (textParts.length > 0) {
          messages.push({ role: 'assistant', content: textParts.join('\n') })
        }
        break
      }

      case 'tool': {
        if (!Array.isArray(msg.content)) break

        for (const part of msg.content) {
          if (part.type === 'tool-result') {
            messages.push({
              role: 'tool',
              tool_call_id: part.toolCallId,
              content: stringifyIfNeeded(part.result ?? part.output),
            })
          }
        }
        break
      }
    }
  }
  return messages
}

/**
 * Converts LLM output tool calls to AI Guard style message format.
 *
 * @param {Array<object>} inputMessages - The input messages already in AI Guard style format
 * @param {Array<{toolCallId: string, toolName: string, args?: unknown, input?: unknown}>} toolCalls
 * @returns {Array<object>}
 */
function buildToolCallOutputMessages (inputMessages, toolCalls) {
  return [
    ...inputMessages,
    {
      role: 'assistant',
      tool_calls: toolCalls.map(tc => ({
        id: tc.toolCallId,
        function: {
          name: tc.toolName,
          arguments: stringifyIfNeeded(tc.args ?? tc.input),
        },
      })),
    },
  ]
}

/**
 * Builds OpenAI-style output messages for the assistant's text response.
 *
 * @param {Array<object>} inputMessages - The input messages already in AI Guard style format
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
 * Parses a Vercel AI content array and dispatches to the appropriate output message builder.
 * Returns `[]` when no assistant tool calls or text content were extractable.
 *
 * @param {Array<object>} inputMessages - The input messages already in AI Guard style format
 * @param {Array<{type: string}>} content - Vercel AI content array from doGenerate/doStream result
 * @returns {Array<object>}
 */
function buildOutputMessages (inputMessages, content) {
  const toolCalls = content.filter(c => c.type === 'tool-call')
  if (toolCalls.length) return buildToolCallOutputMessages(inputMessages, toolCalls)
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  if (text) return buildTextOutputMessages(inputMessages, text)
  return []
}

module.exports = {
  convertVercelPromptToMessages,
  convertFilePartToImageUrl,
  buildToolCallOutputMessages,
  buildTextOutputMessages,
  buildOutputMessages,
}
