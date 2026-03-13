'use strict'

const crypto = require('node:crypto')
const log = require('../../dd-trace/src/log')

/**
 * Computes span pointer attributes for S3 and DynamoDB events.
 *
 * @param {object} event
 * @returns {Array<{ pointer: { kind: string, direction: string, hash: string } }>}
 */
function getSpanPointerAttributes (event) {
  const results = []

  if (Array.isArray(event.Records)) {
    for (const record of event.Records) {
      if (record.s3) {
        const attr = processS3Record(record)
        if (attr) results.push(attr)
      } else if (record.dynamodb && record.eventSourceARN) {
        const attr = processDynamoDBRecord(record)
        if (attr) results.push(attr)
      }
    }
  }

  return results
}

function processS3Record (record) {
  try {
    const bucket = record.s3.bucket.name
    const key = record.s3.object.key
    const eTag = record.s3.object.eTag
    if (!bucket || !key || !eTag) return null

    const hash = generatePointerHash(`${bucket}|${key}|${eTag}`)
    return { pointer: { kind: 'aws.s3.object', direction: 'upstream', hash } }
  } catch (e) {
    log.debug('Error computing S3 span pointer')
    return null
  }
}

function processDynamoDBRecord (record) {
  try {
    const arn = record.eventSourceARN
    const tableName = getTableNameFromARN(arn)
    if (!tableName) return null

    const keys = record.dynamodb?.Keys
    if (!keys) return null

    const sortedKeys = Object.keys(keys).sort()
    const parts = [tableName]
    for (const k of sortedKeys) {
      const val = keys[k]
      const type = Object.keys(val)[0]
      parts.push(`${k}=${val[type]}`)
    }
    const hash = generatePointerHash(parts.join('|'))
    return { pointer: { kind: 'aws.dynamodb.item', direction: 'upstream', hash } }
  } catch (e) {
    log.debug('Error computing DynamoDB span pointer')
    return null
  }
}

function getTableNameFromARN (arn) {
  if (!arn) return null
  const parts = arn.split('/')
  return parts.length >= 2 ? parts[1] : null
}

function generatePointerHash (input) {
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32)
}

module.exports = {
  getSpanPointerAttributes,
}
