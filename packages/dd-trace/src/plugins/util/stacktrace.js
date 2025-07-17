'use strict'

const { relative, sep } = require('path')

const cwd = process.cwd()

const NODE_MODULES_PATTERN_MIDDLE = `${sep}node_modules${sep}`
const NODE_MODULES_PATTERN_START = `node_modules${sep}`

module.exports = {
  getCallSites,
  parseUserLandFrames
}

// From https://github.com/felixge/node-stack-trace/blob/ba06dcdb50d465cd440d84a563836e293b360427/index.js#L1
function getCallSites (constructorOpt) {
  const oldLimit = Error.stackTraceLimit
  Error.stackTraceLimit = Infinity

  const dummy = {}

  const v8Handler = Error.prepareStackTrace
  Error.prepareStackTrace = function (_, v8StackTrace) {
    return v8StackTrace
  }
  Error.captureStackTrace(dummy, constructorOpt)

  const v8StackTrace = dummy.stack
  Error.prepareStackTrace = v8Handler
  Error.stackTraceLimit = oldLimit

  return v8StackTrace
}

/**
 * Get stack trace of user-land frames.
 *
 * @param {string} stack - The stack trace to parse
 * @param {number} [limit=Infinity] - The maximum number of frames to return
 * @returns {StackFrame[]} - A list of stack frames from user-land code
 */
function parseUserLandFrames (stack, limit = Infinity) {
  let index = stack.indexOf('\n    at ')
  const frames = []

  while (index !== -1 && frames.length !== limit) {
    const nextIndex = stack.indexOf('\n', index + 1)
    const frame = parseLine(stack, index, nextIndex === -1 ? stack.length : nextIndex)
    if (frame !== undefined) frames.push(frame)
    index = nextIndex
  }

  return frames
}

/**
 * Parses a line of the stack trace and returns the parsed frame if it is a user-land frame.
 * Returns `undefined` otherwise.
 *
 * @param {string} stack - The stack trace in which the line is located.
 * @param {number} start - The start index of the line to parse within the stack trace.
 * @param {number} end - The end index of the line to parse within the stack trace.
 * @returns {StackFrame|undefined} The parsed frame if it is a user frame, `undefined` otherwise.
 *
 * @typedef {Object} StackFrame
 * @property {string} fileName - The file name of the frame.
 * @property {string} lineNumber - The line number of the frame.
 * @property {string} columnNumber - The column number of the frame.
 * @property {string} [functionName] - The function name of the frame.
 * @property {string} [methodName] - The method name of the frame.
 * @property {string} [typeName] - The type name of the frame.
 */
function parseLine (stack, start, end) {
  let index
  if (stack[end - 1] === ')') {
    index = end - 2 // skip the last closing parenthesis
    const code = stack.charCodeAt(index)
    if (code < 0x30 || code > 0x39) return // not a digit
  } else {
    index = end - 1
  }

  start += 8 // skip the `\n    at ` prefix
  if (stack.startsWith('new ', start)) start += 4 // skip `new `
  else if (stack.startsWith('async ', start)) start += 6 // skip `async `

  let fileName, lineNumber, columnNumber
  const result = parseLocation(stack, start, index)
  if (result === undefined) return
  [fileName, lineNumber, columnNumber, index] = result

  if (isNodeModulesFrame(fileName)) return

  // parse method name
  let methodName, functionName
  if (stack[index] === ']') {
    methodName = ''
    index-- // skip the closing square bracket
    for (; index >= start; index--) {
      const char = stack[index]
      if (char === ' ' && stack.slice(index - 4, index) === ' [as') {
        // The space after `[as` in `[as Foo]`
        index -= 4 // skip ` [as`
        break
      } else if (char === '[') {
        // This isn't a method name after all, but probably a symbol
        functionName = `${stack.slice(start, index)}[${methodName}]`
        methodName = undefined
        break
      }
      methodName = char + methodName
    }
    index-- // skip the opening square bracket
  }

  // parse function and type name
  functionName ??= start <= index ? stack.slice(start, index + 1) : undefined
  let typeName
  if (functionName !== undefined && functionName[0] !== '[') {
    const periodIndex = functionName.indexOf('.')
    if (periodIndex !== -1) {
      typeName = functionName.slice(0, periodIndex)
      functionName = functionName.slice(periodIndex + 1)
    }
  }

  return {
    lineNumber,
    columnNumber,
    fileName,
    methodName,
    functionName,
    typeName
  }
}

// TODO: Technically, the algorithm below could be simplified to not use the relative path, but be simply:
//
//     return filename.includes(NODE_MODULES_PATTERN_MIDDLE))
//
// However, if the user happens to be running this within a directory where `node_modules` is one of the parent
// directories, it will be flagged as a false positive.
function isNodeModulesFrame (fileName) {
  // Quick check first - if it doesn't contain node_modules, it's not a node_modules frame
  if (!fileName.includes(NODE_MODULES_PATTERN_MIDDLE)) {
    return false
  }

  // More expensive relative path calculation only when necessary
  const actualPath = fileName.startsWith('file:') ? fileName.slice(7) : fileName
  const relativePath = relative(cwd, actualPath)

  return relativePath.startsWith(NODE_MODULES_PATTERN_START) || relativePath.includes(NODE_MODULES_PATTERN_MIDDLE)
}

/**
 * A stack trace location can be in one of the following formats:
 *
 * 1. `myscript.js:10:3`
 * 2. `(myscript.js:10:3`
 * 3. `(eval at Foo.a (myscript.js:10:3)`
 * 4. `(eval at Foo.a (myscript.js:10:3), <anonymous>:1:1`
 * 5. `(eval at Foo.a (eval at Bar.z (myscript.js:10:3)`
 * 6. `(eval at Foo.a (eval at Bar.z (myscript.js:10:3), <anonymous>:1:1`
 *
 * Notice how the optional closing parenthesis is not included in the location string at this point. It has been
 * skipped to save time.
 *
 * This function extracts the `myscript.js:10:3` part, passes it, returns the file name, line number, and column
 * number and sets the `index` to the start of the whole location string.
 *
 * @returns {[string, string, string, number]|undefined}
 */
function parseLocation (stack, start, index) {
  // parse column number
  let columnNumber = ''
  for (; index >= start; index--) {
    const code = stack.charCodeAt(index)
    if (code === 0x29) { // closing parenthesis
      // e.g. `eval at Foo.a (eval at Bar.z (myscript.js:10:3))`
      continue
    }
    if (code < 0x30 || code > 0x39) break // not a digit
    columnNumber = stack[index] + columnNumber
  }

  index-- // skip colon

  // parse line number
  let lineNumber = ''
  for (; index >= start; index--) {
    const code = stack.charCodeAt(index)
    if (code < 0x30 || code > 0x39) break // not a digit
    lineNumber = stack[index] + lineNumber
  }

  index-- // skip colon

  // parse file name
  let nestedParenthesis = 1 // 1 instead of 0 because the trailing parenthesis wasn't seen by this function
  let fileName = ''
  for (; index >= start; index--) {
    const char = stack[index]
    if (char === ')') {
      nestedParenthesis++
    } else if (char === '(' && --nestedParenthesis === 0) {
      index -= 2 // skip the opening parenthesis and the whitespace before it
      break
    } else if (nestedParenthesis === 1 && char === ':' && stack.slice(index - 4, index) === 'node') {
      return // e.g. `node:vm:137:12` is not considered a user frame
    }
    fileName = char + fileName
  }

  if (fileName.startsWith('eval at ')) {
    // The location we parsed was not the actual location, but the location inside the eval. Let's parse the nested
    // location, which will be the location of the eval.
    const result = parseLocation(fileName, 0, fileName.lastIndexOf(',') - 2)
    if (result === undefined) return
    [fileName, lineNumber, columnNumber] = result // ignore returned index, as we need to retain the original one
  }

  return [
    fileName,
    lineNumber,
    columnNumber,
    index // return the index, so the caller knows how far we got
  ]
}
