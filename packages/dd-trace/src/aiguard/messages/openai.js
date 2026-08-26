'use strict'

const { FILE_FALLBACK, IMAGE_FALLBACK, stringifyOrEmpty } = require('./utils')

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
 * Converts OpenAI chat-completions messages to the message format expected by AI Guard.
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
 * Extracts OpenAI input messages from a `chat.completions.create` call.
 *
 * @param {object} callArgs - First argument passed to the wrapped method
 * @returns {Array<object>|undefined}
 */
function getChatCompletionsInputMessages (callArgs) {
  return normalizeOpenAIChatMessages(callArgs?.messages)
}

/**
 * Extracts OpenAI output messages from a `chat.completions.create` parsed body.
 *
 * @param {object} body - Parsed response body
 * @returns {Array<object>}
 */
function getChatCompletionsOutputMessages (body) {
  const eligible = []
  const choices = Array.isArray(body?.choices) ? body.choices : []
  for (const choice of choices) {
    const message = choice?.message
    if (
      message?.content != null ||
      message?.tool_calls?.length ||
      message?.refusal != null ||
      message?.function_call != null
    ) {
      eligible.push(message)
    }
  }
  return normalizeOpenAIChatMessages(eligible) ?? []
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
 * Extracts OpenAI input messages from a `responses.create` call.
 *
 * @param {object} callArgs - First argument passed to the wrapped method
 * @returns {Array<object>|undefined}
 */
function getResponsesInputMessages (callArgs) {
  const messages = [
    ...convertOpenAIResponseItemsToMessages(callArgs?.input, 'user'),
    ...convertOpenAIResponsePromptToMessages(callArgs?.prompt),
  ]

  const instructions = typeof callArgs?.instructions === 'string' && callArgs.instructions.length
    ? callArgs.instructions
    : undefined
  if (!instructions) return messages.length ? messages : undefined

  const first = messages[0]
  if (first && (first.role === 'developer' || first.role === 'system')) {
    const merged = { role: 'developer', content: mergeInstructionsWithContent(instructions, first.content) }
    return [merged, ...messages.slice(1)]
  }
  return [{ role: 'developer', content: instructions }, ...messages]
}

/**
 * Merges Responses API instructions with an existing leading developer/system content value.
 *
 * @param {string} instructions
 * @param {string|Array<object>|undefined} content
 * @returns {string|Array<object>}
 */
function mergeInstructionsWithContent (instructions, content) {
  if (Array.isArray(content)) return [{ type: 'text', text: instructions }, ...content]
  if (typeof content === 'string' && content.length) return `${instructions}\n\n${content}`
  return instructions
}

/**
 * Extracts OpenAI output messages from a `responses.create` parsed body.
 *
 * @param {object} body - Parsed response body
 * @returns {Array<object>}
 */
function getResponsesOutputMessages (body) {
  return convertOpenAIResponseItemsToMessages(body?.output, 'assistant')
}

/**
 * Converts one OpenAI reusable prompt variable value to message content.
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
  normalizeOpenAIChatMessages,
  getChatCompletionsInputMessages,
  getChatCompletionsOutputMessages,
  convertOpenAIResponseItemsToMessages,
  convertOpenAIResponsePromptToMessages,
  getResponsesInputMessages,
  getResponsesOutputMessages,
  openAIResponseContentToMessageContent,
}
