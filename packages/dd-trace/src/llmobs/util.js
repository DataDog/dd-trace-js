'use strict'

const { SPAN_KINDS } = require('./constants/tags')

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

module.exports = {
  encodeUnicode,
  validateKind,
  getFunctionArguments,
  spanHasError
}
