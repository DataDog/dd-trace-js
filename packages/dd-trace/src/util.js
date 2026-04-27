'use strict'

const path = require('path')

const createPrivateSymbol = probeCreatePrivateSymbol()

// Attempts to obtain a factory for V8's %CreatePrivateSymbol, a native runtime function that
// produces a property key invisible to all reflection APIs (Object.getOwnPropertySymbols, Proxy, etc.).
function probeCreatePrivateSymbol () {
  // Primary path: --allow-natives-syntax may already be active.
  try {
    // eslint-disable-next-line no-new-func
    return new Function('name', 'return %CreatePrivateSymbol(name)')
  } catch {
    // Alternate path: temporarily enable the flag ourselves, build the factory, then restore it
    // so we don't leak the permissive flag to other code running in the same process.
    try {
      const v8 = require('v8')
      v8.setFlagsFromString('--allow-natives-syntax')
      try {
        // eslint-disable-next-line no-new-func
        return new Function('name', 'return %CreatePrivateSymbol(name)')
      } finally {
        v8.setFlagsFromString('--no-allow-natives-syntax')
      }
    } catch {
      return null // Not V8, or native syntax unavailable, caller falls back to WeakMap.
    }
  }
}

function createPrivateMap (name) {
  const sym = createPrivateSymbol?.(name)
  // if craeting a private symbol was uncessful we fallback to a WeakMap
  if (!sym) return new WeakMap()

  return {
    get (target) { return target?.[sym] },
    set (target, value) { if (target) target[sym] = value },
    has (target) { return !!target && sym in target },
  }
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
  isTrue,
  isFalse,
  isError,
  globMatch,
  createPrivateMap,
  ddBasePath: globalThis.__DD_ESBUILD_BASEPATH || calculateDDBasePath(__dirname),
  normalizePluginEnvName,
}
