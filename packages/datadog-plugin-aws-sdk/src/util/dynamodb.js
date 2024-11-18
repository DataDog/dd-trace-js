const { generatePointerHash } = require('../../../dd-trace/src/util')

/* eslint-disable no-console */
// TODO temp

/**
 * Encodes a DynamoDB attribute value to Buffer for hashing.
 * @param {Object} valueObject - DynamoDB value in AWS format ({ S: string } or { N: string } or { B: Buffer })
 * @returns {Buffer} Encoded value as Buffer, or empty Buffer if invalid input.
 *
 * @example
 * encodeValue({ S: "user123" }) -> Buffer("user123")
 * encodeValue({ N: "42" }) -> Buffer("42")
 * encodeValue({ B: Buffer([1, 2, 3]) }) -> Buffer([1, 2, 3])
 */
const encodeValue = (valueObject) => {
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
        return value
      default:
        console.log('Unsupported DynamoDB type:', type)
        return Buffer.from('')
    }
  } catch (err) {
    console.log('Unable to encode valueObject:', valueObject)
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
    console.log('Empty keySet provided to extractPrimaryKeys.')
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

/**
 * Calculates a hash for DynamoDB PutItem operations using table's configured primary keys.
 *
 * @param {string} tableName - Name of the DynamoDB table.
 * @param {Object} item - Complete PutItem item parameter to be put.
 * @param {Object.<string, Set<string>>} primaryKeyConfig - Mapping of table names to Sets of primary key names
 *                                                         loaded from DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS.
 * @returns {string|undefined} Hash combining table name and primary key/value pairs, or undefined if unable.
 *
 * @example
 * // With env var DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS='{"UserTable":["userId","timestamp"]}'
 * calculatePutItemHash(
 *   'UserTable',
 *   { userId: { S: "user123" }, timestamp: { N: "1234567" }, name: { S: "John" } },
 *   { UserTable: new Set(['userId', 'timestamp']) }
 * )
 */
const calculatePutItemHash = (tableName, item, primaryKeyConfig) => {
  if (!tableName || !item || !primaryKeyConfig) {
    console.log('Unable to calculate hash because missing parameters')
    return
  }
  const primaryKeySet = primaryKeyConfig[tableName]
  if (!primaryKeySet || !(primaryKeySet instanceof Set) || primaryKeySet.size === 0 || primaryKeySet.size > 2) {
    console.log('Invalid dynamo primary key config:', primaryKeyConfig)
    return
  }
  const keyValues = extractPrimaryKeys(primaryKeySet, item)
  return generatePointerHash([tableName, ...keyValues])
}

/**
 * Calculates a hash for DynamoDB operations that have keys provided (UpdateItem, DeleteItem).
 *
 * @param {string} tableName - Name of the DynamoDB table.
 * @param {Object} keys - Object containing primary key/value attributes in DynamoDB format.
 *                       (e.g., { userId: { S: "123" }, sortKey: { N: "456" } })
 * @returns {string|undefined} Hash value combining table name and primary key/value pairs, or undefined if unable.
 *
 * @example
 * calculateKeyBasedOperationsHash(
 *   'UserTable',
 *   { userId: { S: "user123" }, timestamp: { N: "1234567" } }
 * )
 */
const calculateHashWithKnownKeys = (tableName, keys) => {
  if (!tableName || !keys) {
    console.log('Unable to calculate hash because missing parameters')
    return
  }
  const keyValues = extractPrimaryKeys(keys, keys)
  return generatePointerHash([tableName, ...keyValues])
}

module.exports = {
  calculatePutItemHash,
  calculateHashWithKnownKeys,
  encodeValue,
  extractPrimaryKeys
}
