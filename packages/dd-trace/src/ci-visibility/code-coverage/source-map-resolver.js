'use strict'

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')
const { SourceMap } = require('node:module')

const log = require('../../log')

const SOURCE_MAP_PRAGMA_RE = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/

// Cache per-bundle-URL work: one entry stores the parsed SourceMap instance
// and the line-length table for offset-to-position conversion.
const BUNDLE_CACHE = new Map()

function fetchText (url, timeoutMs = 3000) {
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
  // Prefer the last occurrence: pragmas commonly sit at EOF.
  const re = new RegExp(SOURCE_MAP_PRAGMA_RE, 'g')
  let match
  let last = null
  while ((match = re.exec(source)) !== null) last = match[1]
  return last
}

async function loadMapFromReference (bundleUrl, reference) {
  if (reference.startsWith('data:')) {
    const commaIdx = reference.indexOf(',')
    if (commaIdx === -1) return null
    const header = reference.slice(5, commaIdx)
    const body = reference.slice(commaIdx + 1)
    const isBase64 = /;base64/i.test(header)
    const decoded = isBase64
      ? Buffer.from(body, 'base64').toString('utf8')
      : decodeURIComponent(body)
    return JSON.parse(decoded)
  }
  const mapUrl = new URL(reference, bundleUrl).toString()
  const text = await fetchText(mapUrl)
  return JSON.parse(text)
}

/**
 * Precompute a prefix-sum of line lengths so byte offsets in the bundle can
 * be turned into (line, column) pairs cheaply.
 *
 * @param {string} source
 * @returns {number[]} `lineStarts[i]` = byte offset of the start of line i (0-indexed).
 */
function computeLineStarts (source) {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
  }
  return starts
}

function offsetToPosition (lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo, column: offset - lineStarts[lo] }
}

async function getBundleInfo (bundleUrl) {
  if (BUNDLE_CACHE.has(bundleUrl)) return BUNDLE_CACHE.get(bundleUrl)
  let info = null
  try {
    const source = await fetchText(bundleUrl)
    const mapRef = extractSourceMapReference(source)
    if (mapRef) {
      try {
        const mapJson = await loadMapFromReference(bundleUrl, mapRef)
        if (mapJson && mapJson.mappings) {
          info = {
            sourceMap: new SourceMap(mapJson),
            lineStarts: computeLineStarts(source),
          }
        }
      } catch (err) {
        log.debug('Source map load failed for %s: %s', bundleUrl, err?.message)
      }
    }
  } catch (err) {
    log.debug('Bundle fetch failed for %s: %s', bundleUrl, err?.message)
  }
  // Cache even a null miss so we don't re-fetch repeatedly for bundles that
  // legitimately have no source map.
  BUNDLE_CACHE.set(bundleUrl, info)
  return info
}

function normalizeSource (source, bundleUrl) {
  if (!source) return null
  if (source.startsWith('webpack://')) {
    // webpack:///./src/foo.js → src/foo.js
    return source.replace(/^webpack:\/\/[^/]*\/\.?\//, '')
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    try {
      return new URL(source).pathname.replace(/^\//, '')
    } catch {
      return source
    }
  }
  if (source.startsWith('file://')) {
    return source.slice(7)
  }
  if (source.startsWith('/')) {
    // already an absolute-looking path; let the caller strip repo root.
    return source.slice(1)
  }
  return source
}

function urlToPath (url) {
  try {
    const u = new URL(url)
    const p = u.pathname.replace(/^\//, '')
    return p || null
  } catch {
    return null
  }
}

/**
 * Resolve CDP coverage entries to original source file paths. Uses source
 * maps when available, otherwise falls back to the bundle URL's pathname.
 *
 * @param {Array<{url: string, ranges: number[]}>} coverages
 *   `ranges` is a flat array `[start, end, start, end, ...]` of byte offsets
 *   that had `count > 0` in the CDP Profiler snapshot.
 * @returns {Promise<string[]>} Deduped list of touched source file paths.
 */
async function resolveCoverageToSourceFiles (coverages) {
  // Fetch bundles + source maps in parallel (cached per URL) before resolving.
  const validEntries = coverages.filter(e => e.url)
  const infos = await Promise.all(validEntries.map(e => getBundleInfo(e.url)))

  const files = new Set()
  for (const [i, entry] of validEntries.entries()) {
    const { url, ranges } = entry
    const info = infos[i]
    if (!info || !ranges?.length) {
      const p = urlToPath(url)
      if (p) files.add(p)
      continue
    }
    const { sourceMap, lineStarts } = info
    let mapped = false
    for (let j = 0; j < ranges.length; j += 2) {
      const startOffset = ranges[j]
      const { line, column } = offsetToPosition(lineStarts, startOffset)
      const hit = sourceMap.findEntry(line, column)
      if (hit?.originalSource) {
        const norm = normalizeSource(hit.originalSource, url)
        if (norm) {
          files.add(norm)
          mapped = true
        }
      }
    }
    if (!mapped) {
      // Source map existed but none of our offsets resolved — fall back so
      // the bundle itself is still recorded.
      const p = urlToPath(url)
      if (p) files.add(p)
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
  // exported for tests
  extractSourceMapReference,
  computeLineStarts,
  offsetToPosition,
  normalizeSource,
}
