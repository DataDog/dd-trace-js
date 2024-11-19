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

/**
 * Encodes a DynamoDB attribute value to Buffer for span pointer hashing.
 * @param {Object} valueObject - DynamoDB value in AWS format ({ S: string } or { N: string } or { B: Buffer })
 * @returns {Buffer} Encoded value as Buffer, or empty Buffer if invalid input.
 *
 * @example
 * encodeValue({ S: "user123" }) -> Buffer("user123")
 * encodeValue({ N: "42" }) -> Buffer("42")
 * encodeValue({ B: Buffer([1, 2, 3]) }) -> Buffer([1, 2, 3])
 */
function encodeValue (valueObject) {
  if (!valueObject) {
    return Buffer.from('')
  }

  try {
    const type = Object.keys(valueObject)[0]
    const value = valueObject[type]

    switch (type) {
      case 'S':
        return Buffer.from(value)
      case 'N':
        return Buffer.from(value.toString())
      case 'B':
        return Buffer.isBuffer(value) ? value : Buffer.from(value)
      default:
        return Buffer.from('')
    }
  } catch (err) {
    return Buffer.from('')
  }
}

/**
 * Extracts and encodes primary key values from a DynamoDB item.
 * Handles tables with single-key and two-key scenarios.
 *
 * @param {Set<string>|Object} keySet - Set of key names or object of key names/value pairs.
 * @param {Object} keyValuePairs - Object containing key/value pairs.
 * @returns {Array|undefined} [key1Name, key1Value, key2Name, key2Value], or undefined if invalid input.
 *                            key2 entries are empty strings in the single-key case.
 * @example
 * extractPrimaryKeys(new Set(['userId']), {userId: {S: "user123"}})
 * // Returns ["userId", Buffer("user123"), "", ""]
 * extractPrimaryKeys(new Set(['userId', 'timestamp']), {userId: {S: "user123"}, timestamp: {N: "1234}})
 * // Returns ["timestamp", Buffer.from("1234"), "userId", Buffer.from("user123")]
 */
const extractPrimaryKeys = (keySet, keyValuePairs) => {
  const keyNames = keySet instanceof Set
    ? Array.from(keySet)
    : Object.keys(keySet)
  if (keyNames.length === 0) {
    return
  }

  if (keyNames.length === 1) {
    return [keyNames[0], encodeValue(keyValuePairs[keyNames[0]]), '', '']
  } else {
    const [key1, key2] = keyNames.sort()
    return [
      key1,
      encodeValue(keyValuePairs[key1]),
      key2,
      encodeValue(keyValuePairs[key2])
    ]
  }
}

module.exports = {
  isTrue,
  isFalse,
  isError,
  globMatch,
  calculateDDBasePath,
  hasOwn,
  generatePointerHash,
  encodeValue,
  extractPrimaryKeys
}
