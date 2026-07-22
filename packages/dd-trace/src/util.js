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

// Returns a real FinalizationRegistry, or a no-op stand-in on runtimes without it.
/**
 * @param {(heldValue: unknown) => void} callback
 * @returns {FinalizationRegistry<unknown>|object}
 */
function createFinalizationRegistry (callback) {
  return typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry(callback)
    : { register () {}, unregister () {} }
}

// Returns a real WeakRef, or a strong-reference stand-in with the same deref() shape.
/**
 * @template T
 * @param {T} target
 * @returns {WeakRef<T>|{ deref: () => T }}
 */
function createWeakRef (target) {
  return typeof WeakRef === 'function' ? new WeakRef(target) : { deref: () => target }
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

/**
 * Formats a sampling rate as a string with up to 6 decimal digits and no trailing zeros.
 *
 * @param {number} rate
 */
function formatKnuthRate (rate) {
  const string = Number(rate).toFixed(6)
  for (let i = string.length - 1; i > 0; i--) {
    if (string[i] === '0') continue
    return string.slice(0, i + (string[i] === '.' ? 0 : 1))
  }
}

module.exports = {
  isEmpty,
  isTrue,
  isFalse,
  isError,
  createFinalizationRegistry,
  createWeakRef,
  globMatch,
  ddBasePath: globalThis.__DD_ESBUILD_BASEPATH || calculateDDBasePath(__dirname),
  normalizePluginEnvName,
  formatKnuthRate,
}
