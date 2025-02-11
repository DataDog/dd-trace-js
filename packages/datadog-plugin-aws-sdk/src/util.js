'use strict'

const crypto = require('crypto')
const log = require('../../dd-trace/src/log')

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
 * @returns {Buffer|undefined} Encoded value as Buffer, or undefined if invalid input.
 *
 * @example
 * encodeValue({ S: "user123" }) -> Buffer("user123")
 * encodeValue({ N: "42" }) -> Buffer("42")
 * encodeValue({ B: Buffer([1, 2, 3]) }) -> Buffer([1, 2, 3])
 */
function encodeValue (valueObject) {
  if (!valueObject) {
    return
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
        log.debug(`Found unknown type while trying to create DynamoDB span pointer: ${type}`)
    }
  } catch (err) {
    log.debug(`Failed to encode value while trying to create DynamoDB span pointer: ${err.message}`)
  }
}

/**
 * Extracts and encodes primary key values from a DynamoDB item.
 * Handles tables with single-key and two-key scenarios.
 *
 * @param {Set<string>} keySet - Set of primary key names.
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
  const keyNames = Array.from(keySet)
  if (keyNames.length === 0) {
    return
  }

  if (keyNames.length === 1) {
    const value = encodeValue(keyValuePairs[keyNames[0]])
    if (value) {
      return [keyNames[0], value, '', '']
    }
  } else {
    const [key1, key2] = keyNames.sort()
    const value1 = encodeValue(keyValuePairs[key1])
    const value2 = encodeValue(keyValuePairs[key2])
    if (value1 && value2) {
      return [key1, value1, key2, value2]
    }
  }
}

module.exports = {
  generatePointerHash,
  encodeValue,
  extractPrimaryKeys
}
