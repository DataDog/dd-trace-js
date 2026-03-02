'use strict'

/**
 * @typedef {object} AIGuardMessage
 * @property {string} role - The role of the message sender
 * @property {string} [content] - The text content of the message
 * @property {Array<{id: string, function: {name: string, arguments: string}}>} [tool_calls] - Tool calls
 * @property {string} [tool_call_id] - The ID of the tool call being responded to
 */

/**
 * @param {string | Array<{type: string, text?: string}>} content
 * @returns {string}
 */
function extractTextContent (content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  let result = ''
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      result += part.text
    }
  }
  return result
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJsonStringify (value) {
  if (value === undefined || value === null) {
    return '{}'
  }
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

/**
 * @param {string} str
 * @returns {string}
 */
function normalizeArgumentsString (str) {
  if (typeof str !== 'string' || str.trim() === '') {
    return '{}'
  }

  try {
    const parsed = JSON.parse(str)
    // Only allow plain objects (not null, not array)
    if (isPlainObject(parsed)) {
      return str
    }
    // null, array, primitives are normalized to empty object
    return '{}'
  } catch {
    // Broken JSON is wrapped with _raw to preserve information
    return JSON.stringify({ _raw: str })
  }
}

/**
 * @param {object} toolCallPart
 * @param {string} [toolCallPart.toolCallId]
 * @param {string} [toolCallPart.id]
 * @param {string} [toolCallPart.toolName]
 * @param {object} [toolCallPart.function]
 * @param {string} [toolCallPart.function.name]
 * @param {string} [toolCallPart.function.arguments]
 * @param {string} [toolCallPart.name]
 * @param {unknown} [toolCallPart.input]
 * @param {unknown} [toolCallPart.args]
 * @param {string} [toolCallPart.arguments]
 * @returns {{id: string, function: {name: string, arguments: string}}}
 * @throws {TypeError}
 */
function convertToolCallPart (toolCallPart) {
  const id = toolCallPart.toolCallId ?? toolCallPart.id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('Tool call ID must be a non-empty string')
  }

  const name = toolCallPart.toolName ?? toolCallPart.function?.name ?? toolCallPart.name
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('Tool call name must be a non-empty string')
  }

  const raw =
    toolCallPart.input ??
    toolCallPart.args ??
    toolCallPart.function?.arguments ??
    toolCallPart.arguments

  let argsStr
  if (typeof raw === 'string') {
    argsStr = normalizeArgumentsString(raw)
  } else {
    argsStr = safeJsonStringify(raw)
  }

  return {
    id,
    function: {
      name,
      arguments: argsStr
    }
  }
}

/**
 * @param {object} message
 * @returns {AIGuardMessage | AIGuardMessage[]}
 */
function convertMessage (message) {
  const { role, content } = message

  switch (role) {
    case 'system':
    case 'user':
      return {
        role,
        content: extractTextContent(content)
      }

    case 'assistant': {
      if (!Array.isArray(content)) {
        return { role, content: content || '' }
      }

      const textParts = []
      const toolCallParts = []
      for (const part of content) {
        if (part.type === 'text') {
          textParts.push(part)
        } else if (part.type === 'tool-call') {
          toolCallParts.push(part)
        }
      }

      // If there are tool calls, return as assistant with tool_calls
      if (toolCallParts.length > 0) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: toolCallParts.map(convertToolCallPart)
        }
      }

      // Otherwise, return as text content
      let textContent = ''
      for (const part of textParts) {
        textContent += part.text || ''
      }
      return {
        role: 'assistant',
        content: textContent
      }
    }

    case 'tool': {
      if (!Array.isArray(content)) {
        return { role, content: '' }
      }

      // Each tool result becomes a separate message
      const toolMessages = []
      for (const part of content) {
        if (part.type === 'tool-result') {
          toolMessages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: typeof part.result === 'string'
              ? part.result
              : JSON.stringify(part.result)
          })
        }
      }
      return toolMessages
    }

    default:
      return { role, content: extractTextContent(content) }
  }
}

/**
 * @param {Array<object>} prompt
 * @returns {AIGuardMessage[]}
 */
function convertToAIGuardFormat (prompt) {
  const result = []

  for (const message of prompt) {
    const converted = convertMessage(message)
    if (Array.isArray(converted)) {
      result.push(...converted)
    } else {
      result.push(converted)
    }
  }

  return result
}

module.exports = {
  convertToAIGuardFormat,
  convertToolCallPart
}
