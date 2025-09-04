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
  return hash.slice(0, 32)
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
        log.debug('Found unknown type while trying to create DynamoDB span pointer:', type)
    }
  } catch (err) {
    log.debug('Failed to encode value while trying to create DynamoDB span pointer:', err.message)
  }
}

/**
 * Extracts and encodes primary key values from a DynamoDB item.
 * Handles tables with single-key and two-key scenarios.
 *
 * @param {Array<string>} keyNames - Set of primary key names.
 * @param {Object} keyValuePairs - Object containing key/value pairs.
 * @returns {Array|undefined} [key1Name, key1Value, key2Name, key2Value], or undefined if invalid input.
 *                            key2 entries are empty strings in the single-key case.
 * @example
 * extractPrimaryKeys(['userId'], {userId: {S: "user123"}})
 * // Returns ["userId", Buffer("user123"), "", ""]
 * extractPrimaryKeys(['userId', 'timestamp'], {userId: {S: "user123"}, timestamp: {N: "1234}})
 * // Returns ["timestamp", Buffer.from("1234"), "userId", Buffer.from("user123")]
 */
const extractPrimaryKeys = (keyNames, keyValuePairs) => {
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

/**
 * Extracts queue metadata from an SQS queue URL for span tagging.
 * Handles modern and legacy AWS endpoint formats, with or without schemes.
 * Automatically detects AWS partitions (standard, China, GovCloud) from region.
 *
 * @param {string} queueURL - SQS queue URL in any supported format
 * @returns {Object|null} Object with queueName and arn, or null if URL format is invalid
 *
 * @example
 * // Modern AWS SQS URLs
 * extractQueueMetadata('https://sqs.us-east-1.amazonaws.com/123456789012/my-queue')
 * // Returns { queueName: 'my-queue', arn: 'arn:aws:sqs:us-east-1:123456789012:my-queue' }
 *
 * extractQueueMetadata('sqs.eu-west-1.amazonaws.com/123456789012/my-queue') // no scheme
 * // Returns { queueName: 'my-queue', arn: 'arn:aws:sqs:eu-west-1:123456789012:my-queue' }
 *
 * // Legacy AWS SQS URLs
 * extractQueueMetadata('https://us-west-2.queue.amazonaws.com/123456789012/legacy-queue')
 * // Returns { queueName: 'legacy-queue', arn: 'arn:aws:sqs:us-west-2:123456789012:legacy-queue' }
 *
 * extractQueueMetadata('https://queue.amazonaws.com/123456789012/global-legacy-queue')
 * // Returns { queueName: 'global-legacy-queue', arn: 'arn:aws:sqs:us-east-1:123456789012:global-legacy-queue' }
 */
const extractQueueMetadata = queueURL => {
  if (!queueURL) {
    return null
  }

  const parts = queueURL.split('/').filter(Boolean)

  // Check if URL has scheme
  const hasScheme = Boolean(parts[0]?.startsWith('http'))
  const minParts = hasScheme ? 4 : 3

  if (parts.length < minParts) return null

  const accountId = parts[parts.length - 2]
  const queueName = parts[parts.length - 1]
  const host = hasScheme ? parts[1] : parts[0]

  let region = 'us-east-1' // Default region if not found in URL
  if (host.includes('.amazonaws.com')) {
    // sqs.{region}.amazonaws.com or {region}.queue.amazonaws.com
    const startFrom = host.startsWith('sqs.') ? 4 : 0
    const nextDot = host.indexOf('.', startFrom)
    region = host.slice(startFrom, nextDot)
  }

  let partition = 'aws'
  if (region.startsWith('cn-')) {
    partition = 'aws-cn'
  } else if (region.startsWith('us-gov')) {
    partition = 'aws-us-gov'
  }

  const arn = `arn:${partition}:sqs:${region}:${accountId}:${queueName}`
  return { queueName, arn }
}

module.exports = {
  generatePointerHash,
  encodeValue,
  extractPrimaryKeys,
  extractQueueMetadata
}
