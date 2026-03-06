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
 * Extracts a text representation from a LanguageModelV3ToolResultOutput.
 * The output field is a union type with variants: text, json, error-text, error-json, execution-denied, content.
 * @param {object} output - The LanguageModelV3ToolResultOutput object
 * @param {string} output.type - The type of tool result output
 * @param {unknown} [output.value] - The value (for text, json, error-text, error-json, content types)
 * @param {string} [output.reason] - The reason (for execution-denied type)
 * @returns {string}
 */
function extractToolResultContent (output) {
  if (!output || typeof output !== 'object') {
    return ''
  }

  switch (output.type) {
    case 'text':
    case 'error-text':
      return typeof output.value === 'string' ? output.value : ''

    case 'json':
    case 'error-json':
      return safeJsonStringify(output.value)

    case 'execution-denied':
      return output.reason ?? ''

    case 'content': {
      if (!Array.isArray(output.value)) {
        return ''
      }
      let text = ''
      for (const item of output.value) {
        if (item.type === 'text' && typeof item.text === 'string') {
          text += item.text
        }
      }
      return text
    }

    default:
      return safeJsonStringify(output)
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

  const argsStr = typeof raw === 'string' ? normalizeArgumentsString(raw) : safeJsonStringify(raw)

  return {
    id,
    function: {
      name,
      arguments: argsStr,
    },
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
        content: extractTextContent(content),
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

      let textContent = ''
      for (const part of textParts) {
        textContent += part.text || ''
      }

      if (toolCallParts.length > 0) {
        return {
          role: 'assistant',
          content: textContent,
          tool_calls: toolCallParts.map(convertToolCallPart),
        }
      }

      return {
        role: 'assistant',
        content: textContent,
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
            content: extractToolResultContent(part.output),
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
  convertToolCallPart,
}
