'use strict'

const apiGatewayEventV2 = '2.0'

function isAPIGatewayEvent (event) {
  return event.requestContext?.stage !== undefined && event.httpMethod !== undefined && event.resource !== undefined
}

function isAPIGatewayEventV2 (event) {
  return (
    event.requestContext !== undefined &&
    event.version === apiGatewayEventV2 &&
    event.rawQueryString !== undefined &&
    !event.requestContext.domainName?.includes('lambda-url')
  )
}

function isAPIGatewayWebsocketEvent (event) {
  return event.requestContext !== undefined && event.requestContext.messageDirection !== undefined
}

function isALBEvent (event) {
  return event.requestContext !== undefined && event.requestContext.elb !== undefined
}

function isCloudWatchLogsEvent (event) {
  return event.awslogs !== undefined
}

function isCloudWatchEvent (event) {
  return event.source !== undefined && event.source === 'aws.events'
}

function isCloudFrontRequestEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].cf !== undefined
}

function isDynamoDBStreamEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].dynamodb !== undefined
}

function isKinesisStreamEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].kinesis !== undefined
}

function isS3Event (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].s3 !== undefined
}

function isSNSEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].Sns !== undefined
}

function isSQSEvent (event) {
  return Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].eventSource === 'aws:sqs'
}

function isSNSSQSEvent (event) {
  if (Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].eventSource === 'aws:sqs') {
    try {
      const body = JSON.parse(event.Records[0].body)
      if (body.Type === 'Notification' && body.TopicArn) {
        return true
      }
    } catch (e) {
      return false
    }
  }
  return false
}

function isEBSQSEvent (event) {
  if (Array.isArray(event.Records) && event.Records.length > 0 && event.Records[0].eventSource === 'aws:sqs') {
    try {
      const body = JSON.parse(event.Records[0].body)
      return body['detail-type'] !== undefined
    } catch (e) {
      return false
    }
  }
  return false
}

function isAppSyncResolverEvent (event) {
  return event.info !== undefined && event.info.selectionSetGraphQL !== undefined
}

function isEventBridgeEvent (event) {
  return event['detail-type'] !== undefined
}

function isLambdaUrlEvent (event) {
  return event?.requestContext?.domainName?.includes('lambda-url') === true
}

function isStepFunctionsEvent (event) {
  let ev = event
  if (typeof ev.Payload === 'object') {
    ev = ev.Payload
  }
  if (typeof ev._datadog === 'object') {
    ev = ev._datadog
  }
  return (
    typeof ev.Execution === 'object' && typeof ev.State === 'object' && typeof ev.StateMachine === 'object'
  )
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
  isEBSQSEvent,
  isAppSyncResolverEvent,
  isEventBridgeEvent,
  isLambdaUrlEvent,
  isStepFunctionsEvent,
}
