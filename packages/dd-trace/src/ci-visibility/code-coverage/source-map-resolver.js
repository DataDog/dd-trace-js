'use strict'

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const { SourceMap } = require('node:module')
const path = require('node:path')
const { URL, fileURLToPath } = require('node:url')

const log = require('../../log')

const SOURCE_MAP_PRAGMA_RE = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/

// Cache per-bundle URL work so per-test snapshots do not repeatedly fetch
// the same bundle or source map.
const BUNDLE_CACHE = new Map()
const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUES = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE64_DIGITS.length; i++) {
  BASE64_VALUES[BASE64_DIGITS.charCodeAt(i)] = i
}

function fetchText (url, timeoutMs = 3000, redirects = 3) {
  return new Promise((resolve, reject) => {
    let client
    let u
    try {
      u = new URL(url)
    } catch (err) {
      return reject(err)
    }
    if (u.protocol === 'https:') {
      client = https
    } else if (u.protocol === 'http:') {
      client = http
    } else {
      return reject(new Error(`Unsupported protocol ${u.protocol}`))
    }
    const request = client.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume()
        return resolve(fetchText(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timeout fetching ${url}`))
    })
    request.on('error', reject)
  })
}

function extractSourceMapReference (source) {
  if (!source) return null
  const re = new RegExp(SOURCE_MAP_PRAGMA_RE, 'g')
  let match
  let last = null
  while ((match = re.exec(source)) !== null) {
    last = match[1]
  }
  return last
}

async function loadMapFromReference (bundleUrl, reference) {
  if (reference.startsWith('data:')) {
    const commaIdx = reference.indexOf(',')
    if (commaIdx === -1) return null
    const header = reference.slice(5, commaIdx)
    const body = reference.slice(commaIdx + 1)
    const decoded = /;base64/i.test(header)
      ? Buffer.from(body, 'base64').toString('utf8')
      : decodeURIComponent(body)
    return {
      mapJson: JSON.parse(decoded),
      mapUrl: bundleUrl,
    }
  }
  const mapUrl = new URL(reference, bundleUrl).toString()
  const text = await fetchText(mapUrl)
  return {
    mapJson: JSON.parse(text),
    mapUrl,
  }
}

/**
 * Precompute line starts so V8 byte offsets can be converted to source-map
 * line and column positions cheaply.
 *
 * @param {string} source
 * @returns {number[]}
 */
function computeLineStarts (source) {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1)
    }
  }
  return starts
}

function offsetToPosition (lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lineStarts[mid] <= offset) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return { line: lo, column: offset - lineStarts[lo] }
}

function decodeVlq (mappings, index) {
  let result = 0
  let shift = 0
  let continuation
  do {
    const value = BASE64_VALUES[mappings.charCodeAt(index++)]
    continuation = value & 32
    result += (value & 31) << shift
    shift += 5
  } while (continuation)

  const shouldNegate = result & 1
  result >>>= 1
  return {
    index,
    value: shouldNegate ? -result : result,
  }
}

function decodeMappings (mappings) {
  const lines = []
  let line = []
  let generatedColumn = 0
  let sourceIndex = 0
  let originalLine = 0
  let originalColumn = 0
  let nameIndex = 0

  for (let index = 0; index < mappings.length;) {
    const char = mappings[index]
    if (char === ';') {
      lines.push(line)
      line = []
      generatedColumn = 0
      index++
      continue
    }
    if (char === ',') {
      index++
      continue
    }

    let decoded = decodeVlq(mappings, index)
    generatedColumn += decoded.value
    index = decoded.index

    if (index >= mappings.length || mappings[index] === ',' || mappings[index] === ';') {
      line.push({ generatedColumn })
      continue
    }

    decoded = decodeVlq(mappings, index)
    sourceIndex += decoded.value
    index = decoded.index

    decoded = decodeVlq(mappings, index)
    originalLine += decoded.value
    index = decoded.index

    decoded = decodeVlq(mappings, index)
    originalColumn += decoded.value
    index = decoded.index

    if (index < mappings.length && mappings[index] !== ',' && mappings[index] !== ';') {
      decoded = decodeVlq(mappings, index)
      nameIndex += decoded.value
      index = decoded.index
    }

    line.push({
      generatedColumn,
      sourceIndex,
      originalLine,
      originalColumn,
      nameIndex,
    })
  }
  lines.push(line)
  return lines
}

function getSegmentsForRange (decodedMappings, start, end) {
  const segments = []
  for (let line = start.line; line <= end.line; line++) {
    const lineSegments = decodedMappings[line]
    if (!lineSegments?.length) continue

    const startColumn = line === start.line ? start.column : 0
    const endColumn = line === end.line ? end.column : Infinity
    let activeSegment = null

    for (const segment of lineSegments) {
      if (segment.generatedColumn <= startColumn) {
        activeSegment = segment
        continue
      }
      if (segment.generatedColumn > endColumn) {
        break
      }
      segments.push(segment)
    }
    if (activeSegment) {
      segments.push(activeSegment)
    }
  }
  return segments
}

async function getBundleInfo (entry) {
  const bundleUrl = entry.url
  const cached = BUNDLE_CACHE.get(bundleUrl)
  if (cached && (cached.hasSource || !entry.source)) return cached

  let info = {
    hasSource: false,
    hasSourceMap: false,
    mapLoadFailed: false,
    sourceMap: null,
    sourceRoot: '',
    mapUrl: bundleUrl,
    lineStarts: null,
  }

  try {
    const source = entry.source || await fetchText(bundleUrl)
    info.hasSource = true
    const mapRef = extractSourceMapReference(source)
    if (mapRef) {
      info.hasSourceMap = true
      try {
        const loadedMap = await loadMapFromReference(bundleUrl, mapRef)
        if (loadedMap?.mapJson?.mappings) {
          info = {
            ...info,
            sourceMap: new SourceMap(loadedMap.mapJson),
            decodedMappings: decodeMappings(loadedMap.mapJson.mappings),
            sources: loadedMap.mapJson.sources || [],
            lineStarts: computeLineStarts(source),
            sourceRoot: loadedMap.mapJson.sourceRoot || '',
            mapUrl: loadedMap.mapUrl,
          }
        }
      } catch (err) {
        info.mapLoadFailed = true
        log.debug('Source map load failed for %s: %s', bundleUrl, err?.message)
      }
    } else {
      info.lineStarts = computeLineStarts(source)
    }
  } catch (err) {
    info = null
    log.debug('Bundle fetch failed for %s: %s', bundleUrl, err?.message)
  }

  BUNDLE_CACHE.set(bundleUrl, info)
  return info
}

function toPosixPath (filePath) {
  return filePath.replaceAll('\\', '/')
}

function stripQueryAndHash (filePath) {
  return filePath.replace(/[?#].*$/, '')
}

function stripLeadingParentSegments (filePath) {
  return filePath.replace(/^(\.\.\/)+/, '')
}

/**
 * Canonicalize filesystem paths before comparing them to the repository root.
 *
 * @param {string} filePath
 * @returns {string}
 */
function realpathSync (filePath) {
  try {
    return fs.realpathSync.native(filePath)
  } catch {
    return filePath
  }
}

function toRepositoryRelativePath (filePath, repositoryRoot) {
  const normalizedPath = toPosixPath(realpathSync(filePath))
  if (!repositoryRoot) return normalizedPath.replace(/^\/+/, '')

  const normalizedRoot = toPosixPath(realpathSync(repositoryRoot)).replace(/\/+$/, '')
  if (normalizedPath === normalizedRoot) return path.basename(normalizedRoot)
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }
  return null
}

function normalizeRelativePath (filePath) {
  const normalized = path.posix.normalize(toPosixPath(filePath))
  return stripLeadingParentSegments(normalized).replace(/^\.\//, '').replace(/^\/+/, '')
}

function resolveUrlPath (url, repositoryRoot) {
  const pathname = decodeURIComponent(url.pathname)
  if (pathname.startsWith('/@fs/')) {
    return toRepositoryRelativePath(pathname.slice(4), repositoryRoot)
  }
  return normalizeRelativePath(pathname)
}

function normalizeSource (source, options = {}) {
  if (!source) return null
  if (typeof options === 'string') {
    options = { bundleUrl: options }
  }
  const { bundleUrl, mapUrl, sourceRoot, repositoryRoot } = options
  source = stripQueryAndHash(source)

  if (source.startsWith('webpack://')) {
    return normalizeRelativePath(source.replace(/^webpack:\/\/[^/]*\/\.?\//, ''))
  }

  if (source.startsWith('file://')) {
    try {
      return toRepositoryRelativePath(fileURLToPath(source), repositoryRoot)
    } catch {
      return null
    }
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(source)) {
    try {
      return resolveUrlPath(new URL(source), repositoryRoot)
    } catch {
      return null
    }
  }

  if (source.startsWith('/@fs/')) {
    return toRepositoryRelativePath(source.slice(4), repositoryRoot)
  }

  if (source.startsWith('/')) {
    const repositoryRelative = toRepositoryRelativePath(source, repositoryRoot)
    return repositoryRelative || normalizeRelativePath(source)
  }

  if (sourceRoot) {
    if (sourceRoot.startsWith('file://')) {
      try {
        const sourceRootPath = fileURLToPath(sourceRoot)
        return toRepositoryRelativePath(path.resolve(sourceRootPath, source), repositoryRoot)
      } catch {
        return null
      }
    }
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(sourceRoot)) {
      try {
        return resolveUrlPath(new URL(source, sourceRoot), repositoryRoot)
      } catch {
        return null
      }
    }
    if (path.isAbsolute(sourceRoot)) {
      const sourcePath = path.resolve(sourceRoot, source)
      return toRepositoryRelativePath(sourcePath, repositoryRoot) || normalizeRelativePath(sourcePath)
    }
    const rootedSource = path.posix.join(toPosixPath(sourceRoot), source)
    if (mapUrl || bundleUrl) {
      try {
        return resolveUrlPath(new URL(rootedSource, mapUrl || bundleUrl), repositoryRoot)
      } catch {
        return normalizeRelativePath(rootedSource)
      }
    }
    return normalizeRelativePath(rootedSource)
  }

  if (mapUrl || bundleUrl) {
    try {
      return resolveUrlPath(new URL(source, mapUrl || bundleUrl), repositoryRoot)
    } catch {
      // Fall through to path normalization.
    }
  }

  return normalizeRelativePath(source)
}

function urlToPath (url, repositoryRoot) {
  try {
    return resolveUrlPath(new URL(url), repositoryRoot)
  } catch {
    return null
  }
}

/**
 * Resolve CDP coverage entries to original source file paths. Uses source maps
 * when available, otherwise falls back to the bundle URL path.
 *
 * @param {Array<{url: string, ranges: number[], source?: string}>} coverages
 * @param {{repositoryRoot?: string}} [options]
 * @returns {Promise<string[]>}
 */
async function resolveCoverageToSourceFiles (coverages, options = {}) {
  const validEntries = coverages.filter(entry => entry.url && entry.ranges?.length)
  const infos = await Promise.all(validEntries.map(entry => getBundleInfo(entry)))

  const files = new Set()
  for (const [i, entry] of validEntries.entries()) {
    const { url, ranges } = entry
    const info = infos[i]
    if (!info) {
      continue
    }
    if (!info.sourceMap) {
      if (!info.hasSourceMap && !info.mapLoadFailed) {
        const filename = urlToPath(url, options.repositoryRoot)
        if (filename) files.add(filename)
      }
      continue
    }

    const { decodedMappings, lineStarts, sources } = info
    for (let j = 0; j < ranges.length; j += 2) {
      const startOffset = ranges[j]
      const endOffset = ranges[j + 1]
      const start = offsetToPosition(lineStarts, startOffset)
      const end = offsetToPosition(lineStarts, Math.max(startOffset, endOffset - 1))
      const segments = getSegmentsForRange(decodedMappings, start, end)
      for (const segment of segments) {
        const originalSource = sources[segment.sourceIndex]
        if (!originalSource) continue
        const normalized = normalizeSource(originalSource, {
          bundleUrl: url,
          mapUrl: info.mapUrl,
          sourceRoot: info.sourceRoot,
          repositoryRoot: options.repositoryRoot,
        })
        if (normalized) {
          files.add(normalized)
        }
      }
    }
  }
  return [...files]
}

function resetCache () {
  BUNDLE_CACHE.clear()
}

module.exports = {
  resolveCoverageToSourceFiles,
  resetCache,
  extractSourceMapReference,
  computeLineStarts,
  offsetToPosition,
  normalizeSource,
}
