'use strict'

const { SPAN_KINDS } = require('./constants/tags')

/**
 * Encodes a string, formatting unicode characters to their escaped representation.
 * @param {string} str the string to encode
 * @returns {string} the encoded string
 */
function encodeUnicode (str) {
  if (!str) return str
  return str.split('').map(char => {
    const code = char.charCodeAt(0)
    if (code > 127) {
      return `\\u${code.toString(16).padStart(4, '0')}`
    }
    return char
  }).join('')
}

/**
 * Validates a span kind is one of the allowed kinds.
 * @param {'llm'|'agent'|'workflow'|'retrieval'|'embedding'|'task'|'tool'} kind span kind
 * @returns {'llm'|'agent'|'workflow'|'retrieval'|'embedding'|'task'|'tool'} validated span kind
 * @throws if the kind is not one of the valid span kinds
 */
function validateKind (kind) {
  if (!SPAN_KINDS.includes(kind)) {
    throw new Error(`
      Invalid span kind specified: "${kind}"
      Must be one of: ${SPAN_KINDS.join(', ')}
    `)
  }

  return kind
}

/**
 * Extracts the argument names from a function string.
 *
 * This is done by iterating over the characters, and selectively recording them to a string.
 * We skip over any intermediary comments, and assignments to variables as default values.
 *
 * @param {string} str string of the function arguments as defined in the function signature
 * @returns {string[]} the argument names from the function definition.
 */
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

/**
 * Finds the bounds of the arguments in a function string. We cannot go between the first "(" and the last ")" because
 * of:
 * 1. nested functions
 * 2. functions that have a default arrow function as an argument, like `function foo (bar = () => {}) { }`
 * @param {string} fnString - the string representation of the function
 * @returns {[number, number]} - the start and end index of the arguments
 */
function findArgumentsBounds (fnString) {
  let start = -1
  let end = -1
  let closerCount = 0

  for (let i = 0; i < fnString.length; i++) {
    const char = fnString[i]

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

  return [start, end]
}

/**
 * Memoization of functions to their argument names.
 * @type {WeakMap<Function, string[]>}
 */
const memo = new WeakMap()

/**
 * Gets the function arguments as an object, with the
 * keys being their associated function argument names.
 *
 * Spread arguments are collected into an array.
 *
 * @param {Function} fn the function to extract the arguments from
 * @param {any[]} args the arguments to the function
 * @returns {Record<string, any> | any[]} the function arguments as an object,
 *  defaulting to the original arguments if the function cannot be parsed
 */
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
      const [start, end] = findArgumentsBounds(fnString)
      names = parseArgumentNames(fnString.slice(start + 1, end))
      memo.set(fn, names)
    }

    const argsObject = {}

    for (const [argIdx, arg] of args.entries()) {
      const name = names[argIdx]

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

/**
 * Checks if a span has an error by looking at its tags.
 * @param {import('../opentracing/span')} span APM span
 * @returns {boolean} true if the span has an error, false otherwise
 */
function spanHasError (span) {
  const tags = span.context()._tags
  return !!(tags.error || tags['error.type'])
}

module.exports = {
  encodeUnicode,
  validateKind,
  getFunctionArguments,
  spanHasError
}
