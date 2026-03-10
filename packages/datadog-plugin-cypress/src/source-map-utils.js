'use strict'

const fs = require('fs')
const path = require('path')

// Base64 lookup table for source map VLQ decoding
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_DECODE = new Uint8Array(128)
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_DECODE[BASE64_CHARS.charCodeAt(i)] = i
}
const TEST_DECLARATION_RE = /(?:it|test|specify)\s*\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\[\s\S])*)`)\s*,/g
const SOURCE_MAP_CACHE = new Map()

/**
 * Whether a file path references JavaScript.
 * @param {string} absoluteFilePath
 * @returns {boolean}
 */
function isJavaScriptFile (absoluteFilePath) {
  return absoluteFilePath.endsWith('.js') || absoluteFilePath.endsWith('.cjs') || absoluteFilePath.endsWith('.mjs')
}

/**
 * Decide whether invocationDetails line can be trusted as final source line.
 * @param {string} absoluteFilePath
 * @param {number} testSourceLine
 * @returns {boolean}
 */
function shouldTrustInvocationDetailsLine (absoluteFilePath, testSourceLine) {
  if (!Number.isInteger(testSourceLine) || testSourceLine < 1) return false
  if (!isJavaScriptFile(absoluteFilePath)) return false

  return getCachedSourceMap(absoluteFilePath) === null
}

/**
 * Decode one VLQ-encoded integer from `str` at `cursor.pos`, advancing the cursor in place.
 * @param {string} str
 * @param {{ pos: number }} cursor
 * @returns {number}
 */
function decodeVLQ (str, cursor) {
  let result = 0
  let shift = 0
  let digit
  do {
    digit = BASE64_DECODE[str.charCodeAt(cursor.pos++)]
    result |= (digit & 0x1F) << shift
    shift += 5
  } while (digit & 0x20)
  return (result & 1) ? -(result >>> 1) : result >>> 1
}

/**
 * Resolve a source path from a source map entry to an absolute file path.
 * Handles regular relative paths and virtual URL-like source paths.
 * @param {string} mapDir - Directory of the source map (or the file containing the inline source map)
 * @param {string} sourceRoot - The `sourceRoot` field from the source map
 * @param {string} sourcePath - A single entry from the source map's `sources` array
 * @returns {string | null}
 */
function resolveSourcePath (mapDir, sourceRoot, sourcePath) {
  const cleanSourcePath = sourcePath.replace(/[?#].*$/, '')
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(cleanSourcePath)) {
    // Virtual sources may use URL-like schemes (e.g. file://, webpack://, vite://).
    // If they encode an absolute local path in the URL pathname, use it.
    try {
      const pathname = new URL(cleanSourcePath).pathname
      return pathname && path.isAbsolute(pathname) ? pathname : null
    } catch {
      return null
    }
  }
  if (sourceRoot && /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(sourceRoot)) {
    // URL-like sourceRoot values are virtual; resolve relative entries from mapDir.
    return path.resolve(mapDir, sourcePath)
  }
  return path.resolve(mapDir, sourceRoot || '', sourcePath)
}

/**
 * Read a source map for a file. Tries:
 *  1. An adjacent `.map` file (`absoluteFilePath + '.map'`)
 *  2. An inline `data:` URI in the file's last line (`//# sourceMappingURL=data:…`)
 * Returns null when neither source is available or parseable.
 * @param {string} absoluteFilePath
 * @returns {object | null}
 */
function readSourceMap (absoluteFilePath) {
  try {
    return JSON.parse(fs.readFileSync(absoluteFilePath + '.map', 'utf8'))
  } catch {}
  try {
    const content = fs.readFileSync(absoluteFilePath, 'utf8')
    const match = content.match(
      /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([\w+/=\s]+)/
    )
    if (match) {
      return JSON.parse(Buffer.from(match[1].replaceAll(/\s/g, ''), 'base64').toString('utf8'))
    }
  } catch {}
  return null
}

/**
 * Read and cache source maps per file path. Cache stores parse result or null.
 * @param {string} absoluteFilePath
 * @returns {object | null}
 */
function getCachedSourceMap (absoluteFilePath) {
  if (SOURCE_MAP_CACHE.has(absoluteFilePath)) {
    return SOURCE_MAP_CACHE.get(absoluteFilePath)
  }
  const sourceMap = readSourceMap(absoluteFilePath)
  SOURCE_MAP_CACHE.set(absoluteFilePath, sourceMap)
  return sourceMap
}

/**
 * Given a generated file's absolute path and a generated line number, returns the
 * original source file path and line by reading the adjacent .map file or an inline
 * source map embedded in the file. Returns null when no source map is found or the
 * mapping cannot be resolved.
 * @param {string} absoluteFilePath - Absolute path to the generated (compiled or bundled) file
 * @param {number} generatedLine - 1-indexed line number in the generated file
 * @returns {{ sourceFile: string, line: number } | null}
 */
function resolveOriginalSourcePosition (absoluteFilePath, generatedLine) {
  const sourceMap = getCachedSourceMap(absoluteFilePath)
  if (!sourceMap) return null
  const { mappings, sources, sourceRoot } = sourceMap
  if (!mappings || !sources?.length) return null

  const mapDir = path.dirname(absoluteFilePath)
  const cursor = { pos: 0 }
  let srcFile = 0
  let srcLine = 0

  const lines = mappings.split(';')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (!line) continue
    cursor.pos = 0
    while (cursor.pos < line.length) {
      decodeVLQ(line, cursor) // genCol — not needed
      if (cursor.pos < line.length && line[cursor.pos] !== ',') {
        // Segment has source info: srcFileIndex (delta), srcLine (delta), srcCol, [namesIndex]
        srcFile += decodeVLQ(line, cursor)
        srcLine += decodeVLQ(line, cursor)
        decodeVLQ(line, cursor) // srcCol — not needed
        if (cursor.pos < line.length && line[cursor.pos] !== ',') {
          decodeVLQ(line, cursor) // namesIndex — not needed
        }
        if (li === generatedLine - 1) {
          const sourcePath = sources[srcFile]
          if (!sourcePath) return null
          const sourceFile = resolveSourcePath(mapDir, sourceRoot, sourcePath)
          return sourceFile ? { sourceFile, line: srcLine + 1 } : null
        }
      }
      if (cursor.pos < line.length && line[cursor.pos] === ',') cursor.pos++
    }
  }
  return null
}

/**
 * Convert a template literal body (the text between backticks, with `${…}` interpolations)
 * into a regex that matches the runtime-evaluated string. Each `${…}` expression is replaced
 * with `.*?` so the pattern matches whatever value the expression produced at runtime.
 * @param {string} templateBody - Raw template literal content (the text between the backticks)
 * @returns {RegExp}
 */
function templateBodyToRegExp (templateBody) {
  // Split on ${...} expressions, escaping the literal parts and replacing interpolations
  // with .*? wildcards. We handle basic nesting of braces inside ${} to avoid false splits.
  let pattern = ''
  let i = 0
  while (i < templateBody.length) {
    const dollarIdx = templateBody.indexOf('${', i)
    if (dollarIdx === -1) {
      pattern += templateBody.slice(i).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      break
    }
    pattern += templateBody.slice(i, dollarIdx).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    pattern += '.*?'
    // skip past the matching closing brace, counting nested braces
    let depth = 1
    i = dollarIdx + 2
    while (i < templateBody.length && depth > 0) {
      if (templateBody[i] === '{') depth++
      else if (templateBody[i] === '}') depth--
      i++
    }
  }
  return new RegExp(`^${pattern}$`)
}

/**
 * Count 1-indexed line number for a character index in `content`.
 * @param {string} content
 * @param {number} endIndex
 * @returns {number}
 */
function lineNumberForIndex (content, endIndex) {
  let line = 1
  for (let i = 0; i < endIndex; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Extract the first stack frame line number from an invocation stack.
 * Supports Chromium-style ("at fn (file:line:col)") and Firefox-style ("fn@file:line:col").
 * @param {string} stack
 * @returns {number | null}
 */
function firstGeneratedLineFromStack (stack) {
  if (typeof stack !== 'string' || stack.length === 0) return null
  const lines = stack.split('\n')
  for (const line of lines) {
    const match = line.match(/:(\d+):\d+\)?\s*$/)
    if (match) {
      const parsed = Number(match[1])
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed
      }
    }
  }
  return null
}

/**
 * Find the declaration line for a test name by scanning it()/test()/specify() calls.
 * For template literals, `${...}` placeholders are fuzzy-matched against runtime values.
 * @param {string} content
 * @param {string} testName
 * @returns {number | null}
 */
function findTestDeclarationLine (content, testName) {
  TEST_DECLARATION_RE.lastIndex = 0
  let match
  while ((match = TEST_DECLARATION_RE.exec(content)) !== null) {
    const singleQuoted = match[1]
    const doubleQuoted = match[2]
    const templateQuoted = match[3]
    const isTemplate = templateQuoted !== undefined
    const candidateName = singleQuoted ?? doubleQuoted ?? templateQuoted
    if (!candidateName) continue

    const doesMatch = isTemplate
      ? templateBodyToRegExp(candidateName).test(testName)
      : candidateName === testName
    if (doesMatch) {
      return lineNumberForIndex(content, match.index)
    }
  }
  return null
}

/**
 * Find the original source line for a test.
 * It first tries mapping a generated line extracted from invocation stack.
 * If that fails, it scans declaration name and maps the matched generated line
 * through a source map when available.
 * For `.ts` specs, the matched line is already the source line.
 * @param {string} absoluteFilePath - Absolute path to the spec file (compiled JS or .ts)
 * @param {string} testName - The test name passed to `it()`, `test()`, or `specify()`
 * @param {string} invocationStack - Raw invocationDetails stack for the test
 * @returns {number | null} The resolved source line (1-indexed), or null
 */
function resolveSourceLineForTest (absoluteFilePath, testName, invocationStack) {
  const generatedLineFromStack = firstGeneratedLineFromStack(invocationStack)
  if (generatedLineFromStack && !absoluteFilePath.endsWith('.ts')) {
    const stackResolved = resolveOriginalSourcePosition(absoluteFilePath, generatedLineFromStack)
    if (stackResolved) return stackResolved.line
  }

  let content
  try {
    content = fs.readFileSync(absoluteFilePath, 'utf8')
  } catch {
    return null
  }

  const foundLine = findTestDeclarationLine(content, testName)
  if (!foundLine) return null

  if (absoluteFilePath.endsWith('.ts')) return foundLine
  const resolved = resolveOriginalSourcePosition(absoluteFilePath, foundLine)
  if (resolved) return resolved.line
  return null
}

module.exports = { resolveOriginalSourcePosition, resolveSourceLineForTest, shouldTrustInvocationDetailsLine }
