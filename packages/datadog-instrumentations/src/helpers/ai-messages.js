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

const FILE_FALLBACK = '[file]'
const IMAGE_FALLBACK = '[image]'

const OPENAI_RESPONSE_TOOL_CALL_TYPES = new Set([
  'apply_patch_call',
  'code_interpreter_call',
  'computer_call',
  'custom_tool_call',
  'file_search_call',
  'function_call',
  'image_generation_call',
  'local_shell_call',
  'mcp_call',
  'shell_call',
  'web_search_call',
])

const OPENAI_RESPONSE_TOOL_OUTPUT_TYPES = new Set([
  'apply_patch_call_output',
  'computer_call_output',
  'custom_tool_call_output',
  'function_call_output',
  'local_shell_call_output',
  'shell_call_output',
])

/**
 * Returns a stringified value, falling back to an empty string for absent values.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stringifyOrEmpty (value) {
  return stringifyIfNeeded(value) ?? ''
}

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
 * Converts OpenAI chat-completions messages to the message format expected by AI Guard.
 *
 * Modern `tool_calls` messages already match the expected shape. Deprecated chat
 * completions `function_call` and `function` role messages are normalized to the
 * equivalent tool-call shape so AI Guard can classify them as tool interactions.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>|undefined}
 */
function normalizeOpenAIChatMessages (messages) {
  if (!Array.isArray(messages) || messages.length === 0) return

  const normalizedMessages = []
  for (const message of messages) {
    const normalized = normalizeOpenAIChatMessage(message)
    if (normalized) normalizedMessages.push(normalized)
  }
  return normalizedMessages.length ? normalizedMessages : undefined
}

/**
 * Converts one OpenAI chat-completions message to AI Guard's expected shape.
 *
 * @param {object} message
 * @returns {object|undefined}
 */
function normalizeOpenAIChatMessage (message) {
  if (!message || typeof message !== 'object') return

  if (message.role === 'function') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id ?? message.name,
      content: stringifyOrEmpty(message.content),
    }
  }

  if (!message.function_call) return message

  const { function_call: functionCall, ...normalized } = message
  const name = functionCall.name
  normalized.tool_calls ??= [{
    id: message.tool_call_id ?? name,
    function: {
      name,
      arguments: stringifyOrEmpty(functionCall.arguments),
    },
  }]
  return normalized
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
    const converted = openAIResponseItemToMessage(item, defaultRole)
    if (Array.isArray(converted)) {
      for (const message of converted) messages.push(message)
    } else if (converted) {
      messages.push(converted)
    }
  }
  return messages
}

/**
 * Converts OpenAI reusable prompt variables to user messages for AI Guard.
 *
 * The reusable prompt template body is not available on the request, but its
 * variables are user/application-provided content that OpenAI substitutes into
 * the prompt. Screening them closes prompt-only `responses.create({ prompt })`
 * calls and prompt variables used alongside `input`.
 *
 * @param {{variables?: Record<string, string|object>|null}|undefined|null} prompt
 * @returns {Array<object>}
 */
function convertOpenAIResponsePromptToMessages (prompt) {
  const variables = prompt?.variables
  if (!variables || typeof variables !== 'object') return []

  const messages = []
  for (const value of Object.values(variables)) {
    const content = openAIResponsePromptVariableToMessageContent(value)
    if (content != null) messages.push({ role: 'user', content })
  }
  return messages
}

/**
 * Converts one OpenAI reusable prompt variable value to message content.
 *
 * Routes every variable through `openAIResponseContentToMessageContent` so the
 * result follows the same string-when-text-only / array-when-multimodal shape
 * convention used elsewhere in this file. Media variables that produce no
 * usable content (e.g. an `input_image` with no URL or `file_id`) fall back to
 * a stable text marker so AI Guard still observes that a media variable was
 * attached.
 *
 * @param {string|object} value
 * @returns {string|Array<{type: string, text?: string, image_url?: {url: string}}>|undefined}
 */
function openAIResponsePromptVariableToMessageContent (value) {
  let part
  if (typeof value === 'string') {
    part = { type: 'input_text', text: value }
  } else if (value && typeof value === 'object') {
    part = value
  } else {
    return
  }

  const content = openAIResponseContentToMessageContent([part])
  if (content != null) return content
  if (part.type === 'input_image') return IMAGE_FALLBACK
  if (part.type === 'input_file') return FILE_FALLBACK
}

/**
 * Converts one OpenAI Responses API item to an OpenAI chat-style message.
 *
 * @param {object} item
 * @param {string} defaultRole
 * @returns {object|Array<object>|undefined}
 */
function openAIResponseItemToMessage (item, defaultRole) {
  if (!item || typeof item !== 'object') return
  const type = item.type ?? 'message'

  if (type === 'message') {
    const content = openAIResponseContentToMessageContent(item.content)
    if (content != null) return { role: item.role || defaultRole, content }
  } else if (OPENAI_RESPONSE_TOOL_CALL_TYPES.has(type)) {
    return openAIResponseToolCallToMessages(item)
  } else if (OPENAI_RESPONSE_TOOL_OUTPUT_TYPES.has(type)) {
    return openAIResponseToolOutputToMessage(item)
  }
}

/**
 * Converts a Responses API tool-call item to one or more chat-style messages.
 *
 * Most tool-call items represent only the assistant's tool request. MCP and
 * image-generation items can also carry tool output on the same item, so include
 * a linked tool message when output-like fields are present.
 *
 * @param {object} item
 * @returns {object|Array<object>}
 */
function openAIResponseToolCallToMessages (item) {
  const toolCallId = item.call_id ?? item.id ?? item.name ?? item.type
  const message = {
    role: 'assistant',
    tool_calls: [{
      id: toolCallId,
      function: {
        name: item.name ?? item.server_label ?? item.type,
        arguments: stringifyOrEmpty(item.arguments ?? item.input ?? item.action),
      },
    }],
  }

  if (item.output == null && item.result == null && item.error == null) return message
  return [message, openAIResponseToolOutputToMessage(item)]
}

/**
 * Converts a Responses API tool-output item to a chat-style tool message.
 *
 * @param {object} item
 * @returns {object}
 */
function openAIResponseToolOutputToMessage (item) {
  return {
    role: 'tool',
    tool_call_id: item.call_id ?? item.id,
    content: openAIResponseOutputValueToMessageContent(item.output ?? item.result ?? item.error),
  }
}

/**
 * Converts Responses API tool output to message content.
 *
 * @param {unknown} output
 * @returns {string|Array<{type: string, text?: string, image_url?: {url: string}}>}
 */
function openAIResponseOutputValueToMessageContent (output) {
  const content = openAIResponseContentToMessageContent(output)
  return content ?? stringifyOrEmpty(output)
}

/**
 * Converts OpenAI Responses API content to OpenAI chat-style message content.
 *
 * @param {string|Array<string|{type?: string, text?: string, refusal?: string,
 *   image_url?: string|{url?: string}, file_id?: string, file_url?: string,
 *   filename?: string}>|undefined} content
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
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      parts.push({ type: 'text', text: part.refusal })
    } else if (part.type === 'input_image' || part.type === 'image_url') {
      const image = openAIResponseImageContentPart(part)
      if (image) {
        hasImages = true
        parts.push(image)
      }
    } else if (part.type === 'input_file') {
      parts.push({ type: 'text', text: openAIResponseFileContentPart(part) })
    }
  }

  if (!parts.length) return
  if (hasImages) return parts
  return parts.map(part => part.text).join('\n')
}

/**
 * Converts an OpenAI image content part to AI Guard image_url content.
 *
 * @param {{image_url?: string|{url?: string}, file_id?: string, url?: string}} part
 * @returns {{type: 'image_url', image_url: {url: string}}|undefined}
 */
function openAIResponseImageContentPart (part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url
  if (url) return { type: 'image_url', image_url: { url } }
  if (part.file_id) return { type: 'image_url', image_url: { url: part.file_id } }
}

/**
 * Extracts a stable text marker from an OpenAI file content part.
 *
 * @param {{file_id?: string|null, file_url?: string, filename?: string, file_data?: string}} part
 * @returns {string}
 */
function openAIResponseFileContentPart (part) {
  return part.file_id ?? part.file_url ?? part.filename ?? FILE_FALLBACK
}

module.exports = {
  convertVercelPromptToMessages,
  convertFilePartToImageUrl,
  normalizeOpenAIChatMessages,
  buildToolCallOutputMessages,
  buildTextOutputMessages,
  buildOutputMessages,
  convertOpenAIResponseItemsToMessages,
  convertOpenAIResponsePromptToMessages,
  openAIResponseContentToMessageContent,
}
