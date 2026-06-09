'use strict'

const path = require('path')

/**
 * `for-in` with an early return is the only allocation-free shape for
 * "does this object have any own enumerable properties". Microbenchmarks
 * pin it as 1.3-1.4x faster than `Object.keys(obj).length === 0` across
 * small / medium / large objects -- enough that hot paths in the AWS SDK
 * and AppSec reporter promote it.
 *
 * @param {object | undefined} obj
 * @returns {boolean}
 */
function isEmpty (obj) {
  // eslint-disable-next-line no-unreachable-loop
  for (const _ in obj) return false
  return true
}

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

function isError (value) {
  return Boolean(value?.message || value instanceof Error)
}

// Matches a glob pattern to a given subject string
function globMatch (pattern, subject) {
  if (typeof pattern === 'string') pattern = pattern.toLowerCase()
  if (typeof subject === 'string') subject = subject.toLowerCase()
  if (typeof subject === 'number' && Number.isInteger(subject)) subject = String(subject)

  let px = 0 // [p]attern inde[x]
  let sx = 0 // [s]ubject inde[x]
  let nextPx = 0
  let nextSx = 0
  while (px < pattern.length || sx < subject.length) {
    if (px < pattern.length) {
      const c = pattern[px]
      switch (c) {
        case '?':
          if (sx < subject.length) {
            px++
            sx++
            continue
          }
          break
        case '*':
          nextPx = px
          nextSx = sx + 1
          px++
          continue
        default: // ordinary character
          if (sx < subject.length && subject[sx] === c) {
            px++
            sx++
            continue
          }
          break
      }
    }
    if (nextSx > 0 && nextSx <= subject.length) {
      px = nextPx
      sx = nextSx
      continue
    }
    return false
  }
  return true
}

/**
 * Return the segment at {index} when splitting {string} on {separator}, without
 * allocating the intermediate array. Equivalent to
 * `string.split(separator, index + 1)[index]`, but `split` with a limit forces
 * V8 off its constant-limit fast path (per-call ToUint32 plus an array
 * allocation), making it 60-170% slower than this scan for the small inputs
 * tracer code splits (paths, request lines, version strings).
 *
 * @param {string} string
 * @param {string} separator
 * @param {number} index
 * @param {string} [fallback] returned when fewer than {index} + 1 segments exist
 * @returns {string | undefined}
 */
function getSegment (string, separator, index, fallback) {
  let start = 0
  for (let i = 0; i < index; i++) {
    const next = string.indexOf(separator, start)
    if (next === -1) return fallback
    start = next + separator.length
  }
  const end = string.indexOf(separator, start)
  return end === -1 ? string.slice(start) : string.slice(start, end)
}

function calculateDDBasePath (dirname) {
  const dirSteps = dirname.split(path.sep)
  const packagesIndex = dirSteps.lastIndexOf('packages')
  return dirSteps.slice(0, packagesIndex).join(path.sep) + path.sep
}

function normalizePluginEnvName (envPluginName, makeLowercase = false) {
  if (envPluginName.startsWith('@')) {
    envPluginName = envPluginName.slice(1)
  }
  envPluginName = envPluginName.replaceAll(/[^a-z0-9_]/ig, '_')
  return makeLowercase ? envPluginName.toLowerCase() : envPluginName
}

module.exports = {
  isEmpty,
  isTrue,
  isFalse,
  isError,
  globMatch,
  getSegment,
  ddBasePath: globalThis.__DD_ESBUILD_BASEPATH || calculateDDBasePath(__dirname),
  normalizePluginEnvName,
}
