'use strict'

const { gunzipSync } = require('node:zlib')
const log = require('../../dd-trace/src/log')
const eventType = require('./event-type-guards')

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

function isHTTPTriggerEvent (eventSource) {
  return (
    eventSource === 'api-gateway' ||
    eventSource === 'application-load-balancer' ||
    eventSource === 'lambda-function-url'
  )
}

function getAWSPartitionByRegion (region) {
  if (region.startsWith('us-gov-')) {
    return 'aws-us-gov'
  } else if (region.startsWith('cn-')) {
    return 'aws-cn'
  }
  return 'aws'
}

/**
 * @param {object} event
 * @returns {string|undefined}
 */
function parseEventSourceSubType (event) {
  if (eventType.isAPIGatewayEvent(event)) return eventSubTypes.apiGatewayV1
  if (eventType.isAPIGatewayEventV2(event)) return eventSubTypes.apiGatewayV2
  if (eventType.isAPIGatewayWebsocketEvent(event)) return eventSubTypes.apiGatewayWebsocket
  return eventSubTypes.unknown
}

/**
 * @param {object} event
 * @returns {string|undefined}
 */
function parseEventSource (event) {
  if (eventType.isLambdaUrlEvent(event)) return eventTypes.lambdaUrl
  if (
    eventType.isAPIGatewayEvent(event) ||
    eventType.isAPIGatewayEventV2(event) ||
    eventType.isAPIGatewayWebsocketEvent(event)
  ) return eventTypes.apiGateway
  if (eventType.isALBEvent(event)) return eventTypes.applicationLoadBalancer
  if (eventType.isCloudWatchLogsEvent(event)) return eventTypes.cloudWatchLogs
  if (eventType.isCloudWatchEvent(event)) return eventTypes.cloudWatchEvents
  if (eventType.isCloudFrontRequestEvent(event)) return eventTypes.cloudFront
  if (eventType.isDynamoDBStreamEvent(event)) return eventTypes.dynamoDB
  if (eventType.isKinesisStreamEvent(event)) return eventTypes.kinesis
  if (eventType.isS3Event(event)) return eventTypes.s3
  if (eventType.isSNSEvent(event)) return eventTypes.sns
  if (eventType.isSQSEvent(event)) return eventTypes.sqs
  if (eventType.isEventBridgeEvent(event)) return eventTypes.eventBridge
  if (eventType.isStepFunctionsEvent(event)) return eventTypes.stepFunctions
  return undefined
}

/**
 * @param {string|undefined} source
 * @param {object} event
 * @param {object} context
 * @returns {string|undefined}
 */
function parseEventSourceARN (source, event, context) {
  const splitFunctionArn = context.invokedFunctionArn.split(':')
  const region = splitFunctionArn[3]
  const accountId = splitFunctionArn[4]
  const awsARN = getAWSPartitionByRegion(region)

  if (source === 's3') {
    return event.Records[0].s3.bucket.arn
  }
  if (source === 'sns') {
    return event.Records[0].Sns.TopicArn
  }
  if (source === 'sqs') {
    return event.Records[0].eventSourceARN
  }
  if (source === 'cloudfront') {
    const distributionId = event.Records[0].cf.config.distributionId
    return `arn:${awsARN}:cloudfront::${accountId}:distribution/${distributionId}`
  }
  if (source === 'api-gateway') {
    const requestContext = event.requestContext
    return `arn:${awsARN}:apigateway:${region}::/restapis/${requestContext.apiId}/stages/${requestContext.stage}`
  }
  if (source === 'application-load-balancer') {
    return event.requestContext.elb.targetGroupArn
  }
  if (source === 'cloudwatch-logs') {
    const buffer = Buffer.from(event.awslogs.data, 'base64')
    const logs = JSON.parse(gunzipSync(buffer).toString())
    return `arn:${awsARN}:logs:${region}:${accountId}:log-group:${logs.logGroup}`
  }
  if (source === 'cloudwatch-events') {
    return event.resources[0]
  }
  if (source === 'dynamodb') {
    return event.Records[0].eventSourceARN
  }
  if (source === 'kinesis') {
    return event.Records[0].eventSourceARN
  }
  if (source === 'eventbridge') {
    return event.source
  }
  if (source === 'states') {
    let ev = event
    if (typeof ev.Payload === 'object') ev = ev.Payload
    if (typeof ev._datadog === 'object') ev = ev._datadog
    return ev.StateMachine.Id
  }
  return undefined
}

/**
 * @param {object} event
 * @returns {object}
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
      const array = event.routeKey.split(' ')
      httpTags['http.route'] = array[array.length - 1]
    }
    return httpTags
  }

  if (eventType.isALBEvent(event)) {
    httpTags['http.url_details.path'] = event.path
    httpTags['http.method'] = event.httpMethod
    if (event.headers?.Referer) {
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

  return httpTags
}

/**
 * @param {object} event
 * @param {object} context
 * @param {string|undefined} eventSource
 * @returns {object}
 */
function extractTriggerTags (event, context, eventSource) {
  let triggerTags = {}
  if (eventSource) {
    triggerTags['function_trigger.event_source'] = eventSource

    let eventSourceARN
    try {
      eventSourceARN = parseEventSourceARN(eventSource, event, context)
    } catch (error) {
      log.debug(`failed to extract ${eventSource} arn from the event`)
    }
    if (eventSourceARN) {
      triggerTags['function_trigger.event_source_arn'] = eventSourceARN
    }
  }

  if (isHTTPTriggerEvent(eventSource)) {
    try {
      triggerTags = Object.assign(triggerTags, extractHTTPTags(event))
    } catch (error) {
      log.debug(`failed to extract http tags from ${eventSource} event`)
    }
  }
  return triggerTags
}

/**
 * @param {object|undefined} triggerTags
 * @param {*} result
 * @param {boolean} isResponseStreamFunction
 * @returns {string|undefined}
 */
function extractHTTPStatusCodeTag (triggerTags, result, isResponseStreamFunction) {
  const eventSource = triggerTags?.['function_trigger.event_source']
  if (!isHTTPTriggerEvent(eventSource)) return undefined

  const resultStatusCode = result?.statusCode
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
  isHTTPTriggerEvent,
  parseEventSource,
  parseEventSourceSubType,
  parseEventSourceARN,
  extractTriggerTags,
  extractHTTPStatusCodeTag,
}
