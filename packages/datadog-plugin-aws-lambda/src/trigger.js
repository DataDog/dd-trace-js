'use strict'

// Ported from datadog-lambda-js at da9fc3c0c9dca00893f70c9a1bd5ac1254af3b01.
// See test/fixtures/README.md for source mapping and compatibility boundaries.

const { gunzipSync } = require('node:zlib')

const log = require('../../dd-trace/src/log')
const eventType = require('./event-type-guards')

/**
 * @param {string | undefined} eventSource
 */
function isHTTPTriggerEvent (eventSource) {
  return (
    eventSource === 'api-gateway' ||
    eventSource === 'application-load-balancer' ||
    eventSource === 'lambda-function-url'
  )
}

/**
 * @param {string} region
 */
function getAWSPartitionByRegion (region) {
  if (region.startsWith('us-gov-')) {
    return 'aws-us-gov'
  } else if (region.startsWith('cn-')) {
    return 'aws-cn'
  }

  return 'aws'
}

/**
 * @param {Record<string, unknown>} event
 */
function extractCloudWatchLogsEventDecodedLogs (event) {
  const buffer = Buffer.from(event.awslogs.data, 'base64')
  const decompressed = gunzipSync(buffer).toString()
  return JSON.parse(decompressed)
}

// Preserve the pinned shim's envelope order and null behavior.
/* eslint-disable eslint-rules/eslint-safe-typeof-object */
/**
 * @param {Record<string, unknown>} event
 */
function extractStateMachineARN (event) {
  // Extract Payload if available (Legacy lambda parsing)
  if (typeof event.Payload === 'object') {
    event = event.Payload
  }
  // Extract _datadog if available (JSONata v1 parsing)
  if (typeof event._datadog === 'object') {
    event = event._datadog
  }
  return event.StateMachine.Id
}
/* eslint-enable eslint-rules/eslint-safe-typeof-object */

const eventTypes = {
  apiGateway: 'api-gateway',
  applicationLoadBalancer: 'application-load-balancer',
  cloudFront: 'cloudfront',
  cloudWatchEvents: 'cloudwatch-events',
  cloudWatchLogs: 'cloudwatch-logs',
  cloudWatch: 'cloudwatch',
  dynamoDB: 'dynamodb',
  eventBridge: 'eventbridge',
  kinesis: 'kinesis',
  lambdaUrl: 'lambda-function-url',
  s3: 's3',
  sns: 'sns',
  sqs: 'sqs',
  stepFunctions: 'states',
}

const eventSubTypes = {
  apiGatewayV1: 'api-gateway-rest-api',
  apiGatewayV2: 'api-gateway-http-api',
  apiGatewayWebsocket: 'api-gateway-websocket',
  unknown: 'unknown-sub-type',
}

/**
 * @param {Record<string, unknown>} event
 */
function parseEventSourceSubtype (event) {
  if (eventType.isAPIGatewayEvent(event)) {
    return eventSubTypes.apiGatewayV1
  }
  if (eventType.isAPIGatewayEventV2(event)) {
    return eventSubTypes.apiGatewayV2
  }
  if (eventType.isAPIGatewayWebsocketEvent(event)) {
    return eventSubTypes.apiGatewayWebsocket
  }
  return eventSubTypes.unknown
}

/**
 * parseEventSource parses the triggering event to determine the source
 * Possible Returns:
 * api-gateway | application-load-balancer | cloudwatch-logs |
 * cloudwatch-events | cloudfront | dynamodb | kinesis | s3 | sns | sqs | states
 *
 * @param {Record<string, unknown>} event
 */
function parseEventSource (event) {
  if (eventType.isLambdaUrlEvent(event)) {
    return eventTypes.lambdaUrl
  }
  if (
    eventType.isAPIGatewayEvent(event) ||
    eventType.isAPIGatewayEventV2(event) ||
    eventType.isAPIGatewayWebsocketEvent(event)
  ) {
    return eventTypes.apiGateway
  }
  if (eventType.isALBEvent(event)) {
    return eventTypes.applicationLoadBalancer
  }
  if (eventType.isCloudWatchLogsEvent(event)) {
    return eventTypes.cloudWatchLogs
  }
  if (eventType.isCloudWatchEvent(event)) {
    return eventTypes.cloudWatchEvents
  }
  if (eventType.isCloudFrontRequestEvent(event)) {
    return eventTypes.cloudFront
  }
  if (eventType.isDynamoDBStreamEvent(event)) {
    return eventTypes.dynamoDB
  }
  if (eventType.isKinesisStreamEvent(event)) {
    return eventTypes.kinesis
  }
  if (eventType.isS3Event(event)) {
    return eventTypes.s3
  }
  if (eventType.isSNSEvent(event)) {
    return eventTypes.sns
  }
  if (eventType.isSQSEvent(event)) {
    return eventTypes.sqs
  }
  if (eventType.isEventBridgeEvent(event)) {
    return eventTypes.eventBridge
  }
  if (eventType.isStepFunctionsEvent(event)) {
    return eventTypes.stepFunctions
  }
}

/**
 * parseEventSourceARN parses the triggering event to determine the event source's
 * ARN if available. Otherwise we stitch together the ARN
 *
 * @param {string | undefined} source
 * @param {Record<string, unknown>} event
 * @param {{ invokedFunctionArn: string }} context
 */
function parseEventSourceARN (source, event, context) {
  const splitFunctionArn = context.invokedFunctionArn.split(':')
  const region = splitFunctionArn[3]
  const accountId = splitFunctionArn[4]
  const awsARN = getAWSPartitionByRegion(region)
  switch (source) {
    case 's3': {
      return event.Records[0].s3.bucket.arn
    }
    case 'sns': {
      return event.Records[0].Sns.TopicArn
    }
    case 'sqs': {
      return event.Records[0].eventSourceARN
    }
    case 'cloudfront': {
      const distributionId = event.Records[0].cf.config.distributionId
      return `arn:${awsARN}:cloudfront::${accountId}:distribution/${distributionId}`
    }
    case 'api-gateway': {
      const requestContext = event.requestContext
      return `arn:${awsARN}:apigateway:${region}::/restapis/${requestContext.apiId}` +
        `/stages/${requestContext.stage}`
    }
    case 'application-load-balancer': {
      return event.requestContext.elb.targetGroupArn
    }
    case 'cloudwatch-logs': {
      const logs = extractCloudWatchLogsEventDecodedLogs(event)
      return `arn:${awsARN}:logs:${region}:${accountId}:log-group:${logs.logGroup}`
    }
    case 'cloudwatch-events': {
      return event.resources[0]
    }
    case 'dynamodb': {
      return event.Records[0].eventSourceARN
    }
    case 'kinesis': {
      return event.Records[0].eventSourceARN
    }
    case 'eventbridge': {
      return event.source
    }
    case 'states': {
      return extractStateMachineARN(event)
    }
  }
}

/**
 * extractHTTPTags extracts HTTP facet tags from the triggering event
 *
 * @param {Record<string, unknown>} event
 */
function extractHTTPTags (event) {
  const httpTags = {}
  if (eventType.isAPIGatewayEvent(event)) {
    const requestContext = event.requestContext
    const path = requestContext.path
    if (requestContext.domainName) {
      httpTags['http.url'] = `https://${requestContext.domainName}${path ?? ''}`
    }
    httpTags['http.url_details.path'] = path
    httpTags['http.method'] = requestContext.httpMethod
    if (event.headers?.Referer) {
      httpTags['http.referer'] = event.headers.Referer
    }
    if (event.resource) {
      httpTags['http.route'] = event.resource
    }
    return httpTags
  }
  if (eventType.isAPIGatewayEventV2(event)) {
    const requestContext = event.requestContext
    const path = requestContext.http.path
    httpTags['http.url'] = `https://${requestContext.domainName}${path ?? ''}`
    httpTags['http.url_details.path'] = path
    httpTags['http.method'] = requestContext.http.method
    if (event.headers?.Referer) {
      httpTags['http.referer'] = event.headers.Referer
    }
    if (event.routeKey) {
      // "GET /my/endpoint" => "/my/endpoint"
      const array = event.routeKey.split(' ')
      httpTags['http.route'] = array.at(-1)
    }
    return httpTags
  }
  if (eventType.isALBEvent(event)) {
    httpTags['http.url_details.path'] = event.path
    httpTags['http.method'] = event.httpMethod
    if (event.headers && event.headers.Referer) {
      httpTags['http.referer'] = event.headers.Referer
    }
    return httpTags
  }
  if (eventType.isLambdaUrlEvent(event)) {
    const requestContext = event.requestContext
    const path = requestContext.http.path
    if (requestContext.domainName) {
      httpTags['http.url'] = `https://${requestContext.domainName}${path ?? ''}`
    }
    httpTags['http.url_details.path'] = path
    httpTags['http.method'] = requestContext.http.method
    if (event.headers?.Referer) {
      httpTags['http.referer'] = event.headers.Referer
    }
    return httpTags
  }
}

/**
 * extractTriggerTags parses the trigger event object for tags to be added to the span metadata
 *
 * @param {Record<string, unknown>} event
 * @param {{ invokedFunctionArn: string }} context
 * @param {string | undefined} eventSource
 */
function extractTriggerTags (event, context, eventSource) {
  let triggerTags = {}
  if (eventSource) {
    triggerTags['function_trigger.event_source'] = eventSource
    let eventSourceARN
    try {
      eventSourceARN = parseEventSourceARN(eventSource, event, context)
    } catch (error) {
      log.debug('failed to extract %s arn from the event: %s', eventSource, error)
    }
    if (eventSourceARN) {
      triggerTags['function_trigger.event_source_arn'] = eventSourceARN
    }
  }
  if (isHTTPTriggerEvent(eventSource)) {
    try {
      triggerTags = { ...triggerTags, ...extractHTTPTags(event) }
    } catch {
      log.debug('failed to extract http tags from %s event', eventSource)
    }
  }
  return triggerTags
}

/**
 * extractHTTPStatusCode extracts a status code from the response if the Lambda was triggered
 * by API Gateway, ALB, or Lambda Function URL
 *
 * @param {Record<string, string> | undefined} triggerTags
 * @param {{ statusCode?: string | number } | null | undefined} result
 * @param {boolean} isResponseStreamFunction
 */
function extractHTTPStatusCodeTag (triggerTags, result, isResponseStreamFunction) {
  const eventSource = triggerTags?.['function_trigger.event_source']
  if (!isHTTPTriggerEvent(eventSource)) {
    return
  }
  const resultStatusCode = result?.statusCode
  // Return a 502 status if no response is found in
  // any buffered function. Streaming functions returning
  // undefined results will be marked as 200.
  if (result === undefined && !isResponseStreamFunction) {
    return '502'
  } else if (resultStatusCode) {
    return resultStatusCode.toString()
  }

  return '200'
}

module.exports = {
  eventTypes,
  eventSubTypes,
  parseEventSourceSubtype,
  parseEventSource,
  parseEventSourceARN,
  extractTriggerTags,
  extractHTTPStatusCodeTag,
}
