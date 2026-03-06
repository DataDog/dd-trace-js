'use strict'

const fs = require('fs')
const path = require('path')

// Base64 lookup table for source map VLQ decoding
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_DECODE = new Uint8Array(128)
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_DECODE[BASE64_CHARS.charCodeAt(i)] = i
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
 * Handles both regular relative paths and webpack:// virtual module paths.
 * @param {string} mapDir - Directory of the source map (or the file containing the inline source map)
 * @param {string} sourceRoot - The `sourceRoot` field from the source map
 * @param {string} sourcePath - A single entry from the source map's `sources` array
 * @returns {string | null}
 */
function resolveSourcePath (mapDir, sourceRoot, sourcePath) {
  if (sourcePath.startsWith('webpack://')) {
    // webpack://[namespace]/[path] — strip the "webpack://[namespace]" prefix.
    // For local files, [path] is absolute (e.g. "/Users/…/spec.ts").
    const afterProtocol = sourcePath.slice('webpack://'.length)
    const slashIdx = afterProtocol.indexOf('/')
    const withoutNamespace = slashIdx === -1 ? '' : afterProtocol.slice(slashIdx)
    // Strip any query string appended by loaders (e.g. "?babel-loader!")
    const cleanPath = withoutNamespace.replace(/\?.*$/, '')
    return cleanPath && path.isAbsolute(cleanPath) ? cleanPath : null
  }
  if (sourceRoot && sourceRoot.startsWith('webpack://')) {
    // sourceRoot is a webpack:// URL — ignore it and resolve relative to mapDir
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
 * Given a generated file's absolute path and a generated line number, returns the
 * original source file path and line by reading the adjacent .map file or an inline
 * source map embedded in the file. Returns null when no source map is found or the
 * mapping cannot be resolved.
 * @param {string} absoluteFilePath - Absolute path to the generated (compiled or bundled) file
 * @param {number} generatedLine - 1-indexed line number in the generated file
 * @returns {{ sourceFile: string, line: number } | null}
 */
function resolveOriginalSourcePosition (absoluteFilePath, generatedLine) {
  const sourceMap = readSourceMap(absoluteFilePath)
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
 * Find the original source line for a test, resolving through the adjacent source map.
 *
 * Strategy:
 *  1. Try `testSourceLine` (from Cypress's invocationDetails) directly through the source
 *     map. This succeeds when invocationDetails.line happens to be the compiled-JS line
 *     rather than a bundler line.
 *  2. Fall back to scanning the spec file for the it()/test()/specify() call by name:
 *     a. Exact literal match (single/double/backtick quoted, no interpolation).
 *     b. Template-literal fuzzy match: `${…}` placeholders in the source become `.*?`
 *        wildcards that can match whatever the expression evaluated to at runtime.
 *     Then map through the source map (for pre-compiled JS) or return the found line
 *     directly (for .ts specs compiled on-the-fly by Cypress).
 *
 * @param {string} absoluteFilePath - Absolute path to the spec file (compiled JS or .ts)
 * @param {number} testSourceLine - Line as reported by Cypress's invocationDetails
 * @param {string} testName - The test name passed to `it()`, `test()`, or `specify()`
 * @returns {number | null} The resolved source line (1-indexed), or null
 */
function resolveSourceLineForTest (absoluteFilePath, testSourceLine, testName) {
  // Step 1: testSourceLine may already be the compiled JS line — try the source map directly
  const directResolved = resolveOriginalSourcePosition(absoluteFilePath, testSourceLine)
  if (directResolved) return directResolved.line

  // Step 2: scan the file for the it() call by name
  let content
  try {
    content = fs.readFileSync(absoluteFilePath, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n')

  /**
   * Resolve the source line given the 1-indexed line number found by scanning.
   * @param {number} foundLine
   * @returns {number | null}
   */
  const resolveFoundLine = (foundLine) => {
    // Pre-compiled JS: map through the adjacent source map
    const resolved = resolveOriginalSourcePosition(absoluteFilePath, foundLine)
    if (resolved) return resolved.line
    // .ts compiled on-the-fly by Cypress: the found line is already the correct source line
    if (absoluteFilePath.endsWith('.ts')) return foundLine
    return null
  }

  // Step 2a: exact literal match (single/double/backtick-quoted with no interpolation)
  const escapedName = testName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  const literalPattern = new RegExp(`(?:it|test|specify)\\s*\\(\\s*['"\`]${escapedName}['"\`]`)
  for (let i = 0; i < lines.length; i++) {
    if (literalPattern.test(lines[i])) {
      return resolveFoundLine(i + 1)
    }
  }

  // Step 2b: template-literal fuzzy match — handles `template ${expr} string test name`
  // when the test name was already evaluated (e.g. 'template interpolated string test name').
  // We look for it/test/specify calls that open a backtick string on the same line,
  // extract the template body, and check if it could produce the runtime test name.
  const templateStartPattern = /(?:it|test|specify)\s*\(\s*`/
  for (let i = 0; i < lines.length; i++) {
    if (!templateStartPattern.test(lines[i])) continue

    // Extract the template body: collect characters from the opening backtick until the
    // closing backtick (the one immediately followed by a comma or whitespace + comma,
    // i.e. the end of the test-name argument). We join lines to handle multiline literals.
    const backtickStart = lines[i].indexOf('`', lines[i].search(/(?:it|test|specify)\s*\(\s*`/))
    if (backtickStart === -1) continue

    // Build the remaining text starting just after the opening backtick
    let remaining = lines[i].slice(backtickStart + 1)
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      remaining += '\n' + lines[j]
    }

    // Find the closing backtick (not inside ${ })
    let depth = 0
    let bodyEnd = -1
    for (let k = 0; k < remaining.length; k++) {
      if (remaining[k] === '$' && remaining[k + 1] === '{') {
        depth++
        k++ // skip '{'
      } else if (depth > 0 && remaining[k] === '}') {
        depth--
      } else if (depth === 0 && remaining[k] === '`') {
        bodyEnd = k
        break
      }
    }
    if (bodyEnd === -1) continue

    const templateBody = remaining.slice(0, bodyEnd)
    if (templateBodyToRegExp(templateBody).test(testName)) {
      return resolveFoundLine(i + 1)
    }
  }

  return null
}

module.exports = { resolveOriginalSourcePosition, resolveSourceLineForTest }
