'use strict'

// Maps positions of code that was compiled from other files back to lines of those files, the way
// the accuracy checker reads source maps: a generated position takes the original line of the
// mapped segment with the greatest generated column at or before it on the same generated line.
// Segments without a source do not count, and a position with no such segment is not credited.

// Taken before any test runs, since tests replace fs and path functions.
const { readFileSync } = require('node:fs')
const { dirname, resolve } = require('node:path')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUES = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE64.length; i++) BASE64_VALUES[BASE64.charCodeAt(i)] = i

const MARKER = 'sourceMappingURL='

/**
 * The text of the source map at `url`, which a script names in a `//# sourceMappingURL=` comment: an
 * inline data URL, or a file relative to the script.
 *
 * @param {string} url
 * @param {string} filename the script
 * @returns {string | undefined} undefined when it cannot be read
 */
function readSourceMapUrl (url, filename) {
  try {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      const payload = url.slice(comma + 1)
      return url.slice(0, comma).includes(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload)
    }
    return readFileSync(resolve(dirname(filename), url), 'utf8')
  } catch {}
}

/**
 * The URL of a `//# sourceMappingURL=` (or `//@`) comment that ends the code, ignoring trailing
 * whitespace.
 *
 * @param {string} code
 * @returns {string | undefined}
 */
function getSourceMappingUrl (code) {
  let end = code.length
  while (end > 0 && isWhitespace(code.charCodeAt(end - 1))) end--
  const marker = code.lastIndexOf(MARKER, end)
  if (marker === -1) return
  const start = marker + MARKER.length
  if (start >= end) return
  for (let i = start; i < end; i++) {
    if (isWhitespace(code.charCodeAt(i))) return
  }
  let i = marker - 1
  while (i >= 0 && isWhitespace(code.charCodeAt(i))) i--
  const sign = code.charCodeAt(i)
  if ((sign !== 35 && sign !== 64) || code.charCodeAt(i - 1) !== 47 || code.charCodeAt(i - 2) !== 47) return
  return code.slice(start, end)
}

/**
 * @param {number} c
 */
function isWhitespace (c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x16_80 || (c >= 0x20_00 && c <= 0x20_0A) ||
    c === 0x20_28 || c === 0x20_29 || c === 0x20_2F || c === 0x20_5F || c === 0x30_00 || c === 0xFE_FF
}

/**
 * @param {object} map a parsed source map with a `sources` array
 * @param {string} filename the file of the code the map describes, which relative sources resolve against
 * @returns {{ sources: string[], mapPosition: (line: number, column: number) =>
 *   ({ source: number, line: number } | undefined) }} the absolute path of each source, and the
 *   lookup of a generated position (1-based line, 0-based column) as a source index and 1-based line
 */
function createPositionMapper (map, filename) {
  const directory = dirname(filename)
  const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
  const sources = map.sources.map(source =>
    resolve(directory, sourceRoot, String(source ?? '').replace(/^file:\/\//, '')))
  const lines = decodeMappings(typeof map.mappings === 'string' ? map.mappings : '')
  const unsortedLines = new Set()
  for (const segments of lines) {
    for (let i = 3; i < segments.length; i += 3) {
      if (segments[i] < segments[i - 3]) {
        unsortedLines.add(segments)
        break
      }
    }
  }
  return {
    sources,
    mapPosition (line, column) {
      const segments = lines[line - 1]
      if (segments === undefined) return
      const found = unsortedLines.has(segments) ? scan(segments, column) : search(segments, column)
      if (found === -1) return
      return { source: segments[found * 3 + 1], line: segments[found * 3 + 2] + 1 }
    },
  }
}

/**
 * @param {string} mappings
 * @returns {number[][]} for each generated line, triples of generated column, source index and
 *   0-based original line, for segments that have a source
 */
function decodeMappings (mappings) {
  const lines = []
  let segments = []
  let generatedColumn = 0
  let source = 0
  let originalLine = 0
  let fields = 0
  let value = 0
  let shift = 0
  const values = [0, 0, 0, 0]
  const endSegment = () => {
    if (fields === 0) return
    generatedColumn += values[0]
    if (fields >= 4) {
      source += values[1]
      originalLine += values[2]
      segments.push(generatedColumn, source, originalLine)
    }
    fields = 0
  }
  for (let i = 0; i < mappings.length; i++) {
    const c = mappings.charCodeAt(i)
    if (c === 59) { // `;`
      endSegment()
      lines.push(segments)
      segments = []
      generatedColumn = 0
      continue
    }
    if (c === 44) { // `,`
      endSegment()
      continue
    }
    const digit = c < 128 ? BASE64_VALUES[c] : -1
    if (digit === -1) continue
    value += (digit & 31) * 2 ** shift
    if (digit & 32) {
      shift += 5
      continue
    }
    const decoded = value % 2 === 1 ? -Math.floor(value / 2) : Math.floor(value / 2)
    if (fields < 4) values[fields] = decoded
    fields++
    value = 0
    shift = 0
  }
  endSegment()
  lines.push(segments)
  return lines
}

/**
 * The index of the last segment at or before `column`, or -1, in a line ordered by generated column.
 *
 * @param {number[]} segments triples of generated column, source and original line
 * @param {number} column
 */
function search (segments, column) {
  let found = -1
  let low = 0
  let high = segments.length / 3 - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (segments[middle * 3] <= column) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/**
 * In a line that is not ordered, the index of the last segment before the first one past `column`,
 * or -1, as a reader that walks the line in order finds it.
 *
 * @param {number[]} segments triples of generated column, source and original line
 * @param {number} column
 */
function scan (segments, column) {
  let found = -1
  for (let i = 0; i < segments.length; i += 3) {
    if (segments[i] > column) break
    found = i / 3
  }
  return found
}

module.exports = { createPositionMapper, getSourceMappingUrl, readSourceMapUrl }
