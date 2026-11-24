'use strict'

const { S3_PTR_KIND, DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../dd-trace/src/constants')
const log = require('../../dd-trace/src/log')
const aws = require('../../datadog-plugin-aws-sdk/src/util')
const { eventTypes } = require('./trigger')

/** @typedef {{ kind: string, direction: string, hash: string }} SpanPointerAttributes */

/**
 * Compute source consumer pointers before the handler can change event contents.
 * Hashing and DynamoDB key encoding remain shared with the AWS SDK producers.
 * @param {string|undefined} eventSource Classified trigger.
 * @param {Record<string, unknown>} event Lambda event.
 * @returns {SpanPointerAttributes[]|undefined}
 */
function getSpanPointerAttributes (eventSource, event) {
  if (eventSource === eventTypes.s3) return processS3Event(event)
  if (eventSource === eventTypes.dynamoDB) return processDynamoDbEvent(event)
}

/**
 * @param {Record<string, unknown>} event S3 notification.
 * @returns {SpanPointerAttributes[]}
 */
function processS3Event (event) {
  const pointers = []
  if (event.Records) {
    for (const record of event.Records) {
      if (!record.eventName || !record.eventName.startsWith('ObjectCreated')) continue
      const bucket = record.s3?.bucket?.name
      const key = record.s3?.object?.key
      let eTag = record.s3?.object?.eTag
      if (!bucket || !key || !eTag) {
        log.debug('Unable to calculate Lambda S3 span pointer hash because of missing parameters.')
        continue
      }
      if (eTag.startsWith('"') && eTag.endsWith('"')) eTag = eTag.slice(1, -1)
      pointers.push({
        kind: S3_PTR_KIND,
        direction: SPAN_POINTER_DIRECTION.UPSTREAM,
        hash: aws.generatePointerHash([bucket, key, eTag]),
      })
    }
  }
  return pointers
}

/**
 * @param {Record<string, unknown>} event DynamoDB stream event.
 * @returns {SpanPointerAttributes[]}
 */
function processDynamoDbEvent (event) {
  const pointers = []
  if (event.Records) {
    for (const record of event.Records) {
      if (!['INSERT', 'MODIFY', 'REMOVE'].includes(record.eventName)) continue
      const keys = record.dynamodb?.Keys
      const table = record.eventSourceARN ? /table\/([^/]*)/.exec(record.eventSourceARN)?.[1] : undefined
      if (!table || !keys) {
        log.debug('Unable to calculate Lambda DynamoDB span pointer hash because of missing parameters.')
        continue
      }
      const primaryKeys = aws.extractPrimaryKeys(Object.keys(keys), keys)
      if (!primaryKeys) continue
      pointers.push({
        kind: DYNAMODB_PTR_KIND,
        direction: SPAN_POINTER_DIRECTION.UPSTREAM,
        hash: aws.generatePointerHash([table, ...primaryKeys]),
      })
    }
  }
  return pointers
}

module.exports = { getSpanPointerAttributes }
