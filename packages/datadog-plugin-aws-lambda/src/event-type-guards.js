'use strict'

// Ported from datadog-lambda-js at da9fc3c0c9dca00893f70c9a1bd5ac1254af3b01.

const API_GATEWAY_EVENT_V2 = '2.0'

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isAPIGatewayEvent (event) {
  return event.requestContext?.stage !== undefined && event.httpMethod !== undefined && event.resource !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isAPIGatewayEventV2 (event) {
  return (
    event.requestContext !== undefined &&
    event.version === API_GATEWAY_EVENT_V2 &&
    event.rawQueryString !== undefined &&
    !event.requestContext.domainName.includes('lambda-url')
  )
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isAPIGatewayWebsocketEvent (event) {
  return event.requestContext !== undefined && event.requestContext.messageDirection !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isALBEvent (event) {
  return event.requestContext !== undefined && event.requestContext.elb !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isCloudWatchLogsEvent (event) {
  return event.awslogs !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isCloudWatchEvent (event) {
  return event.source !== undefined && event.source === 'aws.events'
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isCloudFrontRequestEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].cf !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isDynamoDBStreamEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].dynamodb !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isKinesisStreamEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].kinesis !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isS3Event (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].s3 !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isSNSEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].Sns !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isSQSEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].eventSource === 'aws:sqs'
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isSNSSQSEvent (event) {
  if (isSQSEvent(event)) {
    try {
      const body = JSON.parse(event.Records[0].body)
      if (body.Type === 'Notification' && body.TopicArn) {
        return true
      }
    } catch {
      return false
    }
  }
  return false
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isEventBridgeSQSEvent (event) {
  if (isSQSEvent(event)) {
    try {
      const body = JSON.parse(event.Records[0].body)
      return body['detail-type'] !== undefined
    } catch {
      return false
    }
  }
  return false
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isAppSyncResolverEvent (event) {
  return event.info !== undefined && event.info.selectionSetGraphQL !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isEventBridgeEvent (event) {
  return event['detail-type'] !== undefined
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isLambdaUrlEvent (event) {
  return event?.requestContext?.domainName?.includes('lambda-url')
}

// Preserve the pinned shim's null/object semantics, including malformed-envelope throws.
/* eslint-disable eslint-rules/eslint-safe-typeof-object */
/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isStepFunctionsEvent (event) {
  // Extract Payload if available (Legacy lambda parsing)
  if (typeof event.Payload === 'object') {
    event = event.Payload
  }
  // Extract _datadog if available (JSONata v1 parsing)
  if (typeof event._datadog === 'object') {
    event = event._datadog
  }
  return (
    typeof event.Execution === 'object' && typeof event.State === 'object' && typeof event.StateMachine === 'object'
  )
}

/* eslint-enable eslint-rules/eslint-safe-typeof-object */

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isMSKEvent (event) {
  return (
    event?.eventSource === 'aws:kafka' &&
    event.records !== null &&
    typeof event.records === 'object' &&
    !Array.isArray(event.records)
  )
}

/** @param {Record<string, unknown>} event Lambda trigger payload. */
function isDurableExecutionEvent (event) {
  return typeof event.DurableExecutionArn === 'string'
}

module.exports = {
  isAPIGatewayEvent,
  isAPIGatewayEventV2,
  isAPIGatewayWebsocketEvent,
  isALBEvent,
  isCloudWatchLogsEvent,
  isCloudWatchEvent,
  isCloudFrontRequestEvent,
  isDynamoDBStreamEvent,
  isKinesisStreamEvent,
  isS3Event,
  isSNSEvent,
  isSQSEvent,
  isSNSSQSEvent,
  isEventBridgeSQSEvent,
  isAppSyncResolverEvent,
  isEventBridgeEvent,
  isLambdaUrlEvent,
  isStepFunctionsEvent,
  isMSKEvent,
  isDurableExecutionEvent,
}
