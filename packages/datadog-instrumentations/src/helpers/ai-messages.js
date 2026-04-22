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
 * Normalizes OpenAI chat.completions messages to AI Guard style.
 *
 * OpenAI messages are already `{role, content, name?, tool_calls?, tool_call_id?}`. This
 * shallow-copies each valid message and strips non-standard fields so we do not leak
 * vendor-specific internals to AI Guard.
 *
 * @param {Array<{role: string, content?: unknown, name?: string, tool_calls?: Array, tool_call_id?: string}>} messages
 * @returns {Array<object>}
 */
function convertChatCompletionMessages (messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || !msg.role) continue
    const normalized = { role: msg.role }
    if (msg.content !== undefined) normalized.content = msg.content
    if (msg.name) normalized.name = msg.name
    if (msg.tool_calls) normalized.tool_calls = msg.tool_calls
    if (msg.tool_call_id) normalized.tool_call_id = msg.tool_call_id
    out.push(normalized)
  }
  return out
}

/**
 * Appends the assistant response from a chat.completions result to the input messages.
 *
 * @param {Array<object>} inputMessages
 * @param {{role?: string, content?: string, tool_calls?: Array}|undefined} message
 *   The message from `response.choices[0].message`.
 * @returns {Array<object>|undefined} The new message list, or undefined when the response
 *   carries no assistant content to evaluate.
 */
function buildChatCompletionOutputMessages (inputMessages, message) {
  if (!message || typeof message !== 'object') return
  const appended = { role: message.role || 'assistant' }
  if (message.content != null) appended.content = message.content
  if (message.tool_calls?.length) appended.tool_calls = message.tool_calls
  if (appended.content == null && !appended.tool_calls) return
  return [...inputMessages, appended]
}

/**
 * Collapses OpenAI Responses API content (string or array of typed parts) into a single
 * string. Accepts `input_text`, `output_text`, and `text` parts; ignores unknown types.
 *
 * @param {string|Array<string|{type?: string, text?: string}>|undefined} content
 * @returns {string|undefined}
 */
const RESPONSES_TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text'])

function normalizeResponsesContent (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return
  const parts = []
  for (const part of content) {
    if (!part) continue
    if (typeof part === 'string') {
      parts.push(part)
    } else if (RESPONSES_TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.length ? parts.join('\n') : undefined
}

/**
 * Converts the OpenAI Responses API `input` field to AI Guard style messages.
 *
 * `input` is either a plain string (shorthand for a single user message) or an array of
 * items. Supported item types: `message`, `function_call`, `function_call_output`. Other
 * types (e.g. `item_reference`) cannot be dereferenced client-side and are skipped.
 *
 * @param {string|Array<object>|undefined} input
 * @returns {Array<object>}
 */
function convertResponsesInput (input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  if (!Array.isArray(input)) return []
  const out = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const type = item.type ?? 'message'
    if (type === 'message') {
      const content = normalizeResponsesContent(item.content)
      if (content == null) continue
      out.push({ role: item.role || 'user', content })
    } else if (type === 'function_call') {
      out.push({
        role: 'assistant',
        tool_calls: [{
          id: item.call_id,
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
          },
        }],
      })
    } else if (type === 'function_call_output') {
      out.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      })
    }
  }
  return out
}

/**
 * Appends the assistant response from a responses.create result to the input messages.
 *
 * Walks `response.output[]` looking for `type: 'message'` (assistant text) and
 * `type: 'function_call'` (tool call). Other output item types are ignored.
 *
 * @param {Array<object>} inputMessages
 * @param {Array<object>|undefined} output - `response.output`
 * @returns {Array<object>|undefined}
 */
function buildResponsesOutputMessages (inputMessages, output) {
  if (!Array.isArray(output) || output.length === 0) return
  const appended = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message') {
      const content = normalizeResponsesContent(item.content)
      if (content != null) appended.push({ role: item.role || 'assistant', content })
    } else if (item.type === 'function_call') {
      appended.push({
        role: 'assistant',
        tool_calls: [{
          id: item.call_id,
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
          },
        }],
      })
    }
  }
  if (!appended.length) return
  return [...inputMessages, ...appended]
}

module.exports = {
  convertVercelPromptToMessages,
  convertFilePartToImageUrl,
  buildToolCallOutputMessages,
  buildTextOutputMessages,
  buildOutputMessages,
  convertChatCompletionMessages,
  buildChatCompletionOutputMessages,
  convertResponsesInput,
  buildResponsesOutputMessages,
  normalizeResponsesContent,
}
