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
 * Given a generated file's absolute path and a generated line number, returns the
 * original source file path and line by reading the adjacent .map file synchronously.
 * Returns null if no source map is found or the mapping cannot be resolved.
 * @param {string} absoluteFilePath - Absolute path to the generated (compiled) file
 * @param {number} generatedLine - 1-indexed line number in the generated file
 * @returns {{ sourceFile: string, line: number } | null}
 */
function resolveOriginalSourcePosition (absoluteFilePath, generatedLine) {
  let sourceMap
  try {
    sourceMap = JSON.parse(fs.readFileSync(absoluteFilePath + '.map', 'utf8'))
  } catch {
    return null
  }
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
          return sourcePath
            ? { sourceFile: path.resolve(mapDir, sourceRoot || '', sourcePath), line: srcLine + 1 }
            : null
        }
      }
      if (cursor.pos < line.length && line[cursor.pos] === ',') cursor.pos++
    }
  }
  return null
}

/**
 * Find the original source line for a test, resolving through the adjacent source map.
 *
 * Strategy:
 *  1. Try `testSourceLine` (from Cypress's invocationDetails) directly through the source
 *     map. Succeeds when Cypress/webpack resolves its eval source maps, giving us the
 *     compiled JS line rather than the webpack bundle line — no name matching needed.
 *  2. Fall back to scanning the spec file for the it() call by name, then map through
 *     the source map (for pre-compiled JS) or return the found line directly (for .ts
 *     specs compiled on-the-fly by Cypress).
 *     Note: template literal test names won't be matched by this scan.
 *
 * @param {string} absoluteFilePath - Absolute path to the spec file (compiled JS or .ts)
 * @param {number} testSourceLine - Line as reported by Cypress's invocationDetails
 * @param {string} testName - The test name passed to `it()`
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
  const escapedName = testName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  const pattern = new RegExp(`it\\s*\\(\\s*['"\`]${escapedName}['"\`]`)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      const foundLine = i + 1
      // Pre-compiled JS: map through the adjacent source map
      const resolved = resolveOriginalSourcePosition(absoluteFilePath, foundLine)
      if (resolved) return resolved.line
      // .ts compiled on-the-fly by Cypress: the found line is already the correct source line
      if (absoluteFilePath.endsWith('.ts')) return foundLine
      return null
    }
  }
  return null
}

module.exports = { resolveOriginalSourcePosition, resolveSourceLineForTest }
