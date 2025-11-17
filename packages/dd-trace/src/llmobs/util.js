'use strict'

const { SPAN_KINDS } = require('./constants/tags')

function encodeUnicode (str = '') {
  let result = ''
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    result += code > 127 ? String.raw`\u${code.toString(16).padStart(4, '0')}` : str[i]
  }
  return result
}

function validateKind (kind) {
  if (!SPAN_KINDS.includes(kind)) {
    throw new Error(`
      Invalid span kind specified: "${kind}"
      Must be one of: ${SPAN_KINDS.join(', ')}
    `)
  }

  return kind
}

// extracts the argument names from a function string
function parseArgumentNames (str) {
  const result = []
  let current = ''
  let closerCount = 0
  let recording = true
  let inSingleLineComment = false
  let inMultiLineComment = false

  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    const nextChar = str[i + 1]

    // Handle single-line comments
    if (!inMultiLineComment && char === '/' && nextChar === '/') {
      inSingleLineComment = true
      i++ // Skip the next character
      continue
    }

    // Handle multi-line comments
    if (!inSingleLineComment && char === '/' && nextChar === '*') {
      inMultiLineComment = true
      i++ // Skip the next character
      continue
    }

    // End of single-line comment
    if (inSingleLineComment && char === '\n') {
      inSingleLineComment = false
      continue
    }

    // End of multi-line comment
    if (inMultiLineComment && char === '*' && nextChar === '/') {
      inMultiLineComment = false
      i++ // Skip the next character
      continue
    }

    // Skip characters inside comments
    if (inSingleLineComment || inMultiLineComment) {
      continue
    }

    if (['{', '[', '('].includes(char)) {
      closerCount++
    } else if (['}', ']', ')'].includes(char)) {
      closerCount--
    } else if (char === '=' && nextChar !== '>' && closerCount === 0) {
      recording = false
      // record the variable name early, and stop counting characters until we reach the next comma
      result.push(current.trim())
      current = ''
      continue
    } else if (char === ',' && closerCount === 0) {
      if (recording) {
        result.push(current.trim())
        current = ''
      }

      recording = true
      continue
    }

    if (recording) {
      current += char
    }
  }

  if (current && recording) {
    result.push(current.trim())
  }

  return result
}

// finds the bounds of the arguments in a function string
function findArgumentsBounds (str) {
  let start = -1
  let end = -1
  let closerCount = 0

  // TODO(BridgeAR): This "breaks" up codePoints.
  // Investigate if this is a problem.
  for (let i = 0; i < str.length; i++) {
    const char = str[i]

    if (char === '(') {
      if (closerCount === 0) {
        start = i
      }

      closerCount++
    } else if (char === ')') {
      closerCount--

      if (closerCount === 0) {
        end = i
        break
      }
    }
  }

  return { start, end }
}

const memo = new WeakMap()
function getFunctionArguments (fn, args = []) {
  if (!fn) return
  if (!args.length) return
  if (args.length === 1) return args[0]

  try {
    let names
    if (memo.has(fn)) {
      names = memo.get(fn)
    } else {
      const fnString = fn.toString()
      const { start, end } = findArgumentsBounds(fnString)
      names = parseArgumentNames(fnString.slice(start + 1, end))
      memo.set(fn, names)
    }

    const argsObject = {}

    for (const argIdx in args) {
      const name = names[argIdx]
      const arg = args[argIdx]

      const spread = name?.startsWith('...')

      // this can only be the last argument
      if (spread) {
        argsObject[name.slice(3)] = args.slice(argIdx)
        break
      }

      argsObject[name] = arg
    }

    return argsObject
  } catch {
    return args
  }
}

function spanHasError (span) {
  const tags = span.context()._tags
  return !!(tags.error || tags['error.type'])
}

/**
 * Extracts chat templates from OpenAI response instructions by replacing
 * variable values with placeholders (e.g., "hello" -> "{{greeting}}").
 *
 * @param {Array} instructions - Array of instruction objects with role and content
 * @param {Object} variables - Map of variable names to values
 * @returns {Array} Array of template objects with role and content containing placeholders
 */
function extractChatTemplateFromInstructions (instructions, variables) {
  if (!instructions || !Array.isArray(instructions)) return []
  if (!variables || typeof variables !== 'object') return []

  const chatTemplate = []

  // Build map of values to placeholders
  const valueToPlaceholder = {}
  for (const [varName, varValue] of Object.entries(variables)) {
    let valueStr
    if (varValue && typeof varValue === 'object' && varValue.text) {
      // Handle ResponseInputText objects
      valueStr = String(varValue.text)
    } else {
      valueStr = String(varValue)
    }

    // Skip empty values
    if (!valueStr) continue

    valueToPlaceholder[valueStr] = `{{${varName}}}`
  }

  // Sort values by length (longest first) to handle overlapping values correctly
  const sortedValues = Object.keys(valueToPlaceholder).sort((a, b) => b.length - a.length)

  // Process each instruction
  for (const instruction of instructions) {
    const role = instruction.role
    if (!role) continue

    const contentItems = instruction.content
    if (!contentItems || !Array.isArray(contentItems)) continue

    // Collect text parts from content items
    const textParts = []
    for (const contentItem of contentItems) {
      const text = contentItem.text
      if (text) {
        textParts.push(String(text))
      }
    }

    if (textParts.length === 0) continue

    // Combine all text parts
    let fullText = textParts.join('')

    // Replace variable values with placeholders (longest first)
    for (const valueStr of sortedValues) {
      const placeholder = valueToPlaceholder[valueStr]
      fullText = fullText.replace(new RegExp(escapeRegex(valueStr), 'g'), placeholder)
    }

    chatTemplate.push({ role, content: fullText })
  }

  return chatTemplate
}

/**
 * Escapes special regex characters in a string
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for use in RegExp
 */
function escapeRegex (str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = {
  encodeUnicode,
  validateKind,
  getFunctionArguments,
  spanHasError,
  extractChatTemplateFromInstructions
}
