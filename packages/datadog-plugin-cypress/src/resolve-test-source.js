'use strict'

const { dirname, isAbsolute, join, resolve } = require('path')
const { readFileSync, existsSync } = require('fs')

const { SourceMapConsumer } = require('../../../vendor/dist/source-map')

const SOURCE_MAPPING_URL = /\/\/# sourceMappingURL=(.+)$/m
const FILE_URI_PREFIX = 'file://'
const DATA_URI_PREFIX = 'data:'
const BASE64_DELIMITER = ';base64,'

const TEST_DECLARATION_PREFIX = '(?:it|test|specify)'

/**
 * Resolve compiled file path and line to original source file and line using source maps.
 * Used when specs are compiled (e.g. TypeScript *.cy.ts → *.cy.js) so we report the
 * source file and line instead of the compiled output.
 *
 * @param {string} compiledFilePath - Absolute path to the compiled/generated file (e.g. .js)
 * @param {number} line - Line number in the compiled file (1-based, as from Mocha invocationDetails)
 * @param {number} [column=0] - Column number in the compiled file (0-based)
 * @returns {{ sourceAbsolutePath: string, sourceLine: number } | null} - Original source location, or null
 */
function resolveTestSourceFromMap (compiledFilePath, line, column = 0) {
  if (!compiledFilePath || line == null || line <= 0) {
    return null
  }
  const sourceMap = readSourceMap(compiledFilePath)
  if (!sourceMap) {
    return null
  }
  try {
    const result = SourceMapConsumer.with(sourceMap.rawMap, null, (consumer) => {
      // source-map library uses 1-based line and 0-based column for originalPositionFor input
      return consumer.originalPositionFor({ line, column })
    })
    if (!result || result.source == null || result.line == null) {
      return null
    }
    const sourceAbsolutePath = resolveOriginalSourcePath(sourceMap.baseDir, sourceMap.rawMap, result.source)
    if (!sourceAbsolutePath) {
      return null
    }
    return { sourceAbsolutePath, sourceLine: result.line }
  } catch {
    return null
  }
}

/**
 * Resolve original source file path from a source map when only the file is needed.
 *
 * @param {string} compiledFilePath
 * @returns {string | null}
 */
function resolveTestSourceFileFromMap (compiledFilePath) {
  const sourceMap = readSourceMap(compiledFilePath)
  if (!sourceMap || !Array.isArray(sourceMap.rawMap.sources)) {
    return null
  }
  let firstResolvedPath = null
  for (const source of sourceMap.rawMap.sources) {
    const resolvedPath = resolveOriginalSourcePath(sourceMap.baseDir, sourceMap.rawMap, source)
    if (!resolvedPath) {
      continue
    }
    if (!firstResolvedPath) {
      firstResolvedPath = resolvedPath
    }
    if (existsSync(resolvedPath)) {
      return resolvedPath
    }
  }
  return firstResolvedPath
}

/**
 * Resolve original source path from source-map metadata.
 *
 * @param {string} baseDir
 * @param {{ sourceRoot?: string }} rawMap
 * @param {string} source
 * @returns {string | null}
 */
function resolveOriginalSourcePath (baseDir, rawMap, source) {
  if (!source) {
    return null
  }
  if (source.startsWith(FILE_URI_PREFIX)) {
    return decodeURIComponent(source.slice(FILE_URI_PREFIX.length))
  }
  if (isAbsolute(source)) {
    return source
  }
  const normalizedSource = source.replace(/^webpack:\/\/\//, '').replace(/^webpack:\/\//, '')
  const sourceRoot = typeof rawMap.sourceRoot === 'string' ? rawMap.sourceRoot : ''

  if (sourceRoot) {
    if (sourceRoot.startsWith(FILE_URI_PREFIX)) {
      const fileSourceRoot = decodeURIComponent(sourceRoot.slice(FILE_URI_PREFIX.length))
      return resolve(fileSourceRoot, normalizedSource)
    }
    if (isAbsolute(sourceRoot)) {
      return resolve(sourceRoot, normalizedSource)
    }
    return resolve(baseDir, sourceRoot, normalizedSource)
  }

  return resolve(baseDir, normalizedSource)
}

/**
 * @typedef {{ rawMap: object, baseDir: string }} SourceMapData
 */

/**
 * Read source map data from either an adjacent .map file or an inline source-map URL.
 *
 * @param {string} compiledFilePath
 * @returns {SourceMapData | null}
 */
function readSourceMap (compiledFilePath) {
  const adjacentMap = compiledFilePath + '.map'
  if (existsSync(adjacentMap)) {
    try {
      return {
        rawMap: JSON.parse(readFileSync(adjacentMap, 'utf8')),
        baseDir: dirname(adjacentMap),
      }
    } catch {
      return null
    }
  }

  try {
    const content = readFileSync(compiledFilePath, 'utf8')
    const match = content.match(SOURCE_MAPPING_URL)
    if (match) {
      const url = match[1].trim()
      if (url.startsWith(DATA_URI_PREFIX)) {
        return decodeInlineSourceMap(url, dirname(compiledFilePath))
      }
      const compiledDir = dirname(compiledFilePath)
      const mapPath = join(compiledDir, url)
      if (!existsSync(mapPath)) {
        return null
      }
      return {
        rawMap: JSON.parse(readFileSync(mapPath, 'utf8')),
        baseDir: dirname(mapPath),
      }
    }
  } catch {
    // ignore read errors
  }
  return null
}

/**
 * Decode an inline source-map URL.
 *
 * @param {string} dataUrl
 * @param {string} baseDir
 * @returns {SourceMapData | null}
 */
function decodeInlineSourceMap (dataUrl, baseDir) {
  const base64Index = dataUrl.indexOf(BASE64_DELIMITER)
  if (base64Index === -1) {
    return null
  }
  try {
    const base64 = dataUrl.slice(base64Index + BASE64_DELIMITER.length)
    const rawMap = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
    return { rawMap, baseDir }
  } catch {
    return null
  }
}

/**
 * Best-effort search for a test declaration line by test title in source code.
 *
 * @param {string} sourceAbsolutePath
 * @param {string} testTitle
 * @returns {number | undefined}
 */
function findTestDeclarationLine (sourceAbsolutePath, testTitle) {
  if (!sourceAbsolutePath || !testTitle) {
    return
  }
  let source
  try {
    source = readFileSync(sourceAbsolutePath, 'utf8')
  } catch {
    return
  }
  const escapedTitle = escapeRegExp(testTitle)
  const declarationRegex = new RegExp(
    `\\b${TEST_DECLARATION_PREFIX}(?:\\.only|\\.skip)?\\s*\\(\\s*(['"\`])${escapedTitle}\\1`
  )
  const lines = source.split('\n')
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (declarationRegex.test(lines[lineIndex])) {
      return lineIndex + 1
    }
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

module.exports = {
  decodeInlineSourceMap,
  findTestDeclarationLine,
  resolveTestSourceFromMap,
  resolveTestSourceFileFromMap,
  readSourceMap,
  resolveOriginalSourcePath,
}
