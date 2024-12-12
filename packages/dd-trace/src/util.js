'use strict'

const crypto = require('crypto')
const path = require('path')

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

function isError (value) {
  if (value instanceof Error) {
    return true
  }
  if (value && value.message) {
    return true
  }
  return false
}

// Matches a glob pattern to a given subject string
function globMatch (pattern, subject) {
  if (typeof pattern === 'string') pattern = pattern.toLowerCase()
  if (typeof subject === 'string') subject = subject.toLowerCase()
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

// TODO: this adds stack traces relative to packages/
// shouldn't paths be relative to the root of dd-trace?
function calculateDDBasePath (dirname) {
  const dirSteps = dirname.split(path.sep)
  const packagesIndex = dirSteps.lastIndexOf('packages')
  return dirSteps.slice(0, packagesIndex + 1).join(path.sep) + path.sep
}

function hasOwn (object, prop) {
  return Object.prototype.hasOwnProperty.call(object, prop)
}

/**
 * Generates a unique hash from an array of strings by joining them with | before hashing.
 * Used to uniquely identify AWS requests for span pointers.
 * @param {string[]} components - Array of strings to hash
 * @returns {string} A 32-character hash uniquely identifying the components
 */
function generatePointerHash (components) {
  // If passing S3's ETag as a component, make sure any quotes have already been removed!
  const dataToHash = components.join('|')
  const hash = crypto.createHash('sha256').update(dataToHash).digest('hex')
  return hash.substring(0, 32)
}

module.exports = {
  isTrue,
  isFalse,
  isError,
  globMatch,
  calculateDDBasePath,
  hasOwn,
  generatePointerHash
}
