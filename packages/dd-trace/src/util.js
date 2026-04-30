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

/**
 * Same `for-in` motivation as {@link isEmpty}; the early return stops
 * counting once the threshold is reached so per-call work is bounded by
 * `n` instead of the full key set.
 *
 * @param {object | undefined} obj
 * @param {number} n
 * @returns {boolean}
 */
function hasAtLeast (obj, n) {
  let count = 0
  // eslint-disable-next-line no-unused-vars
  for (const _ in obj) {
    if (++count >= n) return true
  }
  return false
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
  hasAtLeast,
  isEmpty,
  isTrue,
  isFalse,
  isError,
  globMatch,
  ddBasePath: globalThis.__DD_ESBUILD_BASEPATH || calculateDDBasePath(__dirname),
  normalizePluginEnvName,
}
