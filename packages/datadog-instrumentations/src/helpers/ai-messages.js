'use strict'

/**
 * Converts a LanguageModelV2FilePart with an image mediaType to an AI guard style image_url content part.
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
 * Converts a LanguageModelV2Prompt to the AI guard style message format.
 *
 * Vercel AI v2 prompt entries use content arrays with typed parts (e.g. { type: 'text', text },
 * { type: 'file', data, mediaType }). This function converts them to AI guard style messages.
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
            const args = part.args ?? part.input
            toolCalls.push({
              id: part.toolCallId,
              function: {
                name: part.toolName,
                arguments: typeof args === 'string' ? args : JSON.stringify(args),
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
            const result = part.result ?? part.output
            messages.push({
              role: 'tool',
              tool_call_id: part.toolCallId,
              content: typeof result === 'string' ? result : JSON.stringify(result),
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
 * Converts LLM output tool calls to AI guard style message format.
 *
 * @param {Array<object>} inputMessages - The input messages already in AI guard style format
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
 * Builds OpenAI-style output messages for the assistant's text response.
 *
 * @param {Array<object>} inputMessages - The input messages already in AI guard style format
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
 *
 * @param {Array<object>} inputMessages - The input messages already in AI guard style format
 * @param {Array<{type: string}>} content - Vercel AI content array from doGenerate/doStream result
 * @returns {Array<object>}
 */
function buildOutputMessages (inputMessages, content) {
  const toolCalls = content.filter(c => c.type === 'tool-call')
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  if (toolCalls.length) return buildToolCallOutputMessages(inputMessages, toolCalls)
  if (text) return buildTextOutputMessages(inputMessages, text)
  return inputMessages
}

/**
 * Converts OpenAI Responses API input/output items to OpenAI chat-style messages.
 *
 * @param {string|Array<object>|undefined} items
 * @param {string} defaultRole
 * @returns {Array<object>}
 */
function convertOpenAIResponseItemsToMessages (items, defaultRole) {
  if (typeof items === 'string') return [{ role: defaultRole, content: items }]
  if (!Array.isArray(items)) return []

  const messages = []
  for (const item of items) {
    const message = openAIResponseItemToMessage(item, defaultRole)
    if (message) messages.push(message)
  }
  return messages
}

/**
 * Converts one OpenAI Responses API item to an OpenAI chat-style message.
 *
 * @param {object} item
 * @param {string} defaultRole
 * @returns {object|undefined}
 */
function openAIResponseItemToMessage (item, defaultRole) {
  if (!item || typeof item !== 'object') return
  const type = item.type ?? 'message'

  if (type === 'message') {
    const content = openAIResponseContentToMessageContent(item.content)
    if (content != null) return { role: item.role || defaultRole, content }
  } else if (type === 'function_call') {
    return {
      role: 'assistant',
      tool_calls: [{
        id: item.call_id,
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
        },
      }],
    }
  } else if (type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.call_id,
      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
    }
  }
}

/**
 * Converts OpenAI Responses API content to OpenAI chat-style message content.
 *
 * @param {string|Array<string|{type?: string, text?: string, image_url?: string|{url?: string}}>|undefined} content
 * @returns {string|Array<{type: string, text?: string, image_url?: {url: string}}>|undefined}
 */
function openAIResponseContentToMessageContent (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return

  const parts = []
  let hasImages = false

  for (const part of content) {
    if (!part) continue
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part })
    } else if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') &&
      typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'input_image' || part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.url
      if (url) {
        hasImages = true
        parts.push({ type: 'image_url', image_url: { url } })
      }
    }
  }

  if (!parts.length) return
  if (hasImages) return parts
  return parts.map(part => part.text).join('\n')
}

module.exports = {
  convertVercelPromptToMessages,
  convertFilePartToImageUrl,
  buildToolCallOutputMessages,
  buildTextOutputMessages,
  buildOutputMessages,
  convertOpenAIResponseItemsToMessages,
  openAIResponseContentToMessageContent,
}
