'use strict'

const log = require('../../dd-trace/src/log')
const { eventTypes, parseEventSource } = require('./trigger')
const { parseLambdaARN } = require('./arn')

const DD_SERVICE_ENV_VAR = 'DD_SERVICE'

let serviceMapping = null

function initServiceMapping () {
  if (serviceMapping !== null) return
  serviceMapping = {}
  const str = process.env.DD_SERVICE_MAPPING || ''
  for (const entry of str.split(',')) {
    const parts = entry.split(':').map(function (p) { return p.trim() })
    if (parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1]) {
      serviceMapping[parts[0]] = parts[1]
    }
  }
}

function getServiceMapping (serviceName) {
  initServiceMapping()
  return serviceMapping[serviceName]
}

function determineServiceName (specificKey, genericKey, extractedKey, fallback) {
  initServiceMapping()
  const mapped = serviceMapping[specificKey] || serviceMapping[genericKey]
  if (mapped) return mapped

  if (
    process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED === 'false' ||
    process.env.DD_TRACE_AWS_SERVICE_REPRESENTATION_ENABLED === '0'
  ) {
    return fallback
  }

  return extractedKey?.trim() ? extractedKey : fallback
}

function isApiGatewayAsync (event) {
  if (event.headers?.['X-Amz-Invocation-Type'] === 'Event') {
    return 'async'
  }
  return 'sync'
}

function getResourcePath (event) {
  const routeKey = event?.requestContext?.routeKey
  if (routeKey && routeKey.includes('{')) {
    try {
      return routeKey.split(' ')[1]
    } catch (e) {
      log.debug('Error parsing routeKey')
    }
  }
  return event.rawPath || event.requestContext?.resourcePath || routeKey
}

function getEventSubType (event) {
  if (event.version === '2.0') return 'v2'
  if (event.requestContext?.messageDirection) return 'websocket'
  return 'v1'
}

/**
 * @param {object} event
 * @param {object|undefined} context - Lambda context
 * @param {object|undefined} parentSpanContext
 * @param {object} tracer
 * @param {boolean} [decodeAuthorizerContext]
 * @returns {{ span: object, isAsync: boolean }|undefined}
 */
function createInferredSpan (event, context, parentSpanContext, tracer, decodeAuthorizerContext) {
  if (decodeAuthorizerContext === undefined) decodeAuthorizerContext = true
  const service = process.env[DD_SERVICE_ENV_VAR]
  const eventSource = parseEventSource(event)

  if (eventSource === eventTypes.lambdaUrl) {
    return createLambdaUrlSpan(event, context, parentSpanContext, tracer, service)
  }
  if (eventSource === eventTypes.apiGateway) {
    return createApiGatewaySpan(event, context, parentSpanContext, tracer, service, decodeAuthorizerContext)
  }
  if (eventSource === eventTypes.sns) {
    return createSnsSpan(event, context, parentSpanContext, tracer, service)
  }
  if (eventSource === eventTypes.dynamoDB) {
    return createDynamoDBSpan(event, context, parentSpanContext, tracer, service)
  }
  if (eventSource === eventTypes.sqs) {
    return createSqsSpan(event, context, parentSpanContext, tracer, service)
  }
  if (eventSource === eventTypes.kinesis) {
    return createKinesisSpan(event, context, parentSpanContext, tracer, service)
  }
  if (eventSource === eventTypes.s3) {
    return createS3Span(event, context, parentSpanContext, tracer, service)
  }
  if (eventSource === eventTypes.eventBridge) {
    return createEventBridgeSpan(event, context, parentSpanContext, tracer, service)
  }
  return undefined
}

function createApiGatewaySpan (event, context, parentSpanContext, tracer, service, decodeAuthorizerContext) {
  const domain = event.requestContext.domainName || ''
  const path = event.rawPath || event.requestContext.path || event.requestContext.routeKey
  const httpUrl = `https://${domain}${path}`
  const resourcePath = getResourcePath(event)

  let method
  if (event.requestContext.httpMethod) {
    method = event.requestContext.httpMethod
  } else if (event.requestContext.http) {
    method = event.requestContext.http.method
  }
  const resourceName = [method || domain, resourcePath].join(' ')
  const apiId = event.requestContext.apiId || ''
  const serviceName = determineServiceName(apiId, 'lambda_api_gateway', domain, domain)

  const tags = {
    'http.url': httpUrl,
    endpoint: path,
    resource_names: resourceName,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'web',
    'resource.name': resourceName,
    'peer.service': service,
    'span.kind': 'server',
    apiid: apiId,
    _inferred_span: { tag_source: 'self', synchronicity: isApiGatewayAsync(event) },
  }

  if (method) {
    tags['http.method'] = method
    tags.stage = event.requestContext.stage
    tags.domain_name = domain
  }
  if (event.requestContext.messageDirection) {
    tags.message_direction = event.requestContext.messageDirection
    tags.connection_id = event.requestContext.connectionId
    tags.event_type = event.requestContext.eventType
  }

  let childOf = parentSpanContext
  const eventSourceSubType = getEventSubType(event)

  // Authorizer span decoding
  if (decodeAuthorizerContext) {
    try {
      const parsedHeaders = getInjectedAuthorizerHeaders(event, eventSourceSubType)
      if (parsedHeaders) {
        const startTime = parsedHeaders['x-datadog-parent-span-finish-time'] / 1e6
        if (eventSourceSubType === 'v2') {
          // V2: no authorizer span, just adjust start time
          tags._startTime = startTime
        } else {
          const authSpan = tracer.startSpan('aws.apigateway.authorizer', {
            startTime,
            childOf: parentSpanContext,
            tags: Object.assign({}, tags),
          })
          const endTime = event.requestContext.requestTimeEpoch + event.requestContext.authorizer.integrationLatency
          authSpan.finish(endTime)
          childOf = authSpan
          tags._startTime = endTime
        }
      }
    } catch (error) {
      log.debug('Error decoding authorizer span')
    }
  }

  let startTime = tags._startTime
  delete tags._startTime
  if (!startTime) {
    if (eventSourceSubType === 'v1' || eventSourceSubType === 'websocket') {
      startTime = event.requestContext.requestTimeEpoch
    } else {
      startTime = event.requestContext.timeEpoch
    }
  }

  if (context?.invokedFunctionArn && apiId) {
    const { region } = parseLambdaARN(context.invokedFunctionArn)
    if (region) {
      const apiType = eventSourceSubType === 'v2' ? 'apis' : 'restapis'
      tags.dd_resource_key = `arn:aws:apigateway:${region}::/${apiType}/${apiId}`
    }
  }

  const spanName = eventSourceSubType === 'v2' ? 'aws.httpapi' : 'aws.apigateway'
  const span = tracer.startSpan(spanName, { startTime, childOf, tags })
  return { span, isAsync: isApiGatewayAsync(event) === 'async' }
}

function createLambdaUrlSpan (event, context, parentSpanContext, tracer, service) {
  const domain = event.requestContext.domainName || ''
  const path = event.rawPath
  const httpUrl = `https://${domain}${path}`
  let method
  if (event.requestContext.httpMethod) {
    method = event.requestContext.httpMethod
  } else if (event.requestContext.http) {
    method = event.requestContext.http.method
  }
  const resourceName = [method || domain, path].join(' ')
  const apiId = event.requestContext.apiId || ''
  const serviceName = determineServiceName(apiId, 'lambda_url', domain, domain)

  const tags = {
    operation_name: 'aws.lambda.url',
    'http.url': httpUrl,
    endpoint: path,
    'http.method': event.requestContext.http.method,
    resource_names: resourceName,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'http',
    'resource.name': resourceName,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'sync' },
  }

  const options = {
    startTime: event.requestContext.timeEpoch,
    tags,
  }
  if (parentSpanContext) options.childOf = parentSpanContext

  const span = tracer.startSpan('aws.lambda.url', options)
  return { span, isAsync: false }
}

function createDynamoDBSpan (event, context, parentSpanContext, tracer, service) {
  const record = event.Records[0]
  const { eventSourceARN, eventName, eventVersion, eventID, dynamodb } = record
  const parts = eventSourceARN?.split('/') || ['', '']
  const tableName = parts[1] || ''
  const resourceName = `${eventName} ${tableName}`
  const serviceName = determineServiceName(tableName, 'lambda_dynamodb', tableName, 'aws.dynamodb')

  const tags = {
    operation_name: 'aws.dynamodb',
    tablename: tableName,
    resource_names: resourceName,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'web',
    'resource.name': resourceName,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'async' },
    event_name: eventName,
    event_version: eventVersion,
    event_source_arn: eventSourceARN,
    event_id: eventID,
  }
  if (dynamodb) {
    tags.stream_view_type = dynamodb.StreamViewType
    tags.size_bytes = dynamodb.SizeBytes
  }

  const options = {
    startTime: Number(dynamodb?.ApproximateCreationDateTime) * 1000,
    tags,
  }
  if (parentSpanContext) options.childOf = parentSpanContext

  const span = tracer.startSpan('aws.dynamodb', options)
  return { span, isAsync: true }
}

function createSnsSpan (event, context, parentSpanContext, tracer, service) {
  let referenceRecord
  let eventSubscriptionArn = ''
  if (event.Records) {
    referenceRecord = event.Records[0].Sns
    eventSubscriptionArn = event.Records[0].EventSubscriptionArn || ''
  } else {
    referenceRecord = event
  }

  const { TopicArn, Timestamp, Type, Subject, MessageId } = referenceRecord
  const topicName = TopicArn?.split(':').pop() || ''
  const serviceName = determineServiceName(topicName, 'lambda_sns', topicName, 'sns')

  const tags = {
    operation_name: 'aws.sns',
    resource_names: topicName,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'sns',
    'resource.name': topicName,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'async' },
    type: Type,
    subject: Subject,
    message_id: MessageId,
    topicname: topicName,
    topic_arn: TopicArn,
  }
  if (eventSubscriptionArn) {
    tags.event_subscription_arn = eventSubscriptionArn
  }

  const options = {
    startTime: Date.parse(Timestamp),
    tags,
  }
  if (parentSpanContext) options.childOf = parentSpanContext

  const span = tracer.startSpan('aws.sns', options)
  return { span, isAsync: true }
}

function createSqsSpan (event, context, parentSpanContext, tracer, service) {
  const record = event.Records[0]
  const { attributes, eventSourceARN, receiptHandle } = record
  const { SentTimestamp, ApproximateReceiveCount, SenderId } = attributes
  const queueName = eventSourceARN?.split(':').pop() || ''
  const serviceName = determineServiceName(queueName, 'lambda_sqs', queueName, 'sqs')

  const tags = {
    operation_name: 'aws.sqs',
    resource_names: queueName,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'web',
    'resource.name': queueName,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'async' },
    queuename: queueName,
    event_source_arn: eventSourceARN,
    receipt_handle: receiptHandle,
    sender_id: SenderId,
  }
  if (ApproximateReceiveCount && Number(ApproximateReceiveCount) > 0) {
    tags.retry_count = Number(ApproximateReceiveCount)
  }

  // Check if SQS message wraps an SNS or EventBridge message
  let upstreamSpan = null
  try {
    const body = JSON.parse(record.body)
    if (body && body.TopicArn && body.Timestamp) {
      const result = createSnsSpan(body, context, parentSpanContext, tracer, service)
      upstreamSpan = result.span
      upstreamSpan.finish(Number(SentTimestamp))
    } else if (body?.detail?._datadog) {
      const result = createEventBridgeSpan(body, context, parentSpanContext, tracer, service)
      upstreamSpan = result.span
      upstreamSpan.finish(Number(SentTimestamp))
    }
  } catch (e) {
    // Raw SQS message
  }

  const options = {
    startTime: Number(SentTimestamp),
    childOf: upstreamSpan || parentSpanContext,
    tags,
  }

  const span = tracer.startSpan('aws.sqs', options)
  return { span, isAsync: true }
}

function createKinesisSpan (event, context, parentSpanContext, tracer, service) {
  const record = event.Records[0]
  const { kinesis, eventSourceARN, eventName, eventVersion, eventID } = record
  const { approximateArrivalTimestamp, partitionKey } = kinesis
  const streamName = (eventSourceARN?.split(':').pop() || '').replace(/^stream\//, '')
  const shardId = eventID.split(':').pop()
  const serviceName = determineServiceName(streamName, 'lambda_kinesis', streamName, 'kinesis')

  const tags = {
    operation_name: 'aws.kinesis',
    resource_names: streamName,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'web',
    'resource.name': streamName,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'async' },
    streamname: streamName,
    event_id: eventID,
    event_name: eventName,
    event_source_arn: eventSourceARN,
    event_version: eventVersion,
    partition_key: partitionKey,
    shardid: shardId,
  }

  const options = {
    startTime: Number(approximateArrivalTimestamp) * 1000,
    tags,
  }
  if (parentSpanContext) options.childOf = parentSpanContext

  const span = tracer.startSpan('aws.kinesis', options)
  return { span, isAsync: true }
}

function createS3Span (event, context, parentSpanContext, tracer, service) {
  const record = event.Records[0]
  const { s3: { bucket, object: obj }, eventTime, eventName } = record
  const serviceName = determineServiceName(bucket.name, 'lambda_s3', bucket.name, 's3')

  const tags = {
    operation_name: 'aws.s3',
    resource_names: bucket.name,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'web',
    'resource.name': bucket.name,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'async' },
    bucketname: bucket.name,
    bucket_arn: bucket.arn,
    event_name: eventName,
    object_key: obj.key,
    object_size: obj.size,
    object_etag: obj.eTag,
  }

  const options = {
    startTime: Date.parse(eventTime),
    tags,
  }
  if (parentSpanContext) options.childOf = parentSpanContext

  const span = tracer.startSpan('aws.s3', options)
  return { span, isAsync: true }
}

function createEventBridgeSpan (event, context, parentSpanContext, tracer, service) {
  const { time, source } = event
  const serviceName = determineServiceName(source, 'lambda_eventbridge', source, 'eventbridge')

  const tags = {
    operation_name: 'aws.eventbridge',
    resource_names: source,
    request_id: context?.awsRequestId,
    service: serviceName,
    'service.name': serviceName,
    'span.type': 'web',
    'resource.name': source,
    'peer.service': service,
    'span.kind': 'server',
    _inferred_span: { tag_source: 'self', synchronicity: 'async' },
  }

  const options = {
    startTime: Date.parse(time),
    tags,
  }
  if (parentSpanContext) options.childOf = parentSpanContext

  const span = tracer.startSpan('aws.eventbridge', options)
  return { span, isAsync: true }
}

/**
 * Extracts injected authorizer headers from API Gateway events.
 * @param {object} event
 * @param {string} subType - 'v1', 'v2', or 'websocket'
 * @returns {object|null}
 */
function getInjectedAuthorizerHeaders (event, subType) {
  let authorizerHeaders
  if (subType === 'v1' || subType === 'websocket') {
    authorizerHeaders = event.requestContext?.authorizer
  } else if (subType === 'v2') {
    authorizerHeaders = event.requestContext?.authorizer?.lambda
  }
  if (!authorizerHeaders) return null

  // Check for Datadog context in authorizer
  const ddContext = authorizerHeaders._datadog
  if (ddContext) {
    try {
      return typeof ddContext === 'string' ? JSON.parse(ddContext) : ddContext
    } catch (e) {
      return null
    }
  }
  return null
}

module.exports = {
  createInferredSpan,
  getServiceMapping,
  determineServiceName,
  getInjectedAuthorizerHeaders,
}
