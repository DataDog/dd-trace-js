'use strict'

// Ported from datadog-lambda-js at da9fc3c0; synthetic spans stay private to this plugin.

const log = require('../../dd-trace/src/log')
const { parseLambdaARN } = require('./arn')
const { getInjectedAuthorizerHeaders, PARENT_SPAN_FINISH_TIME_HEADER } = require('./context/http')
const { eventTypes, eventSubTypes, parseEventSource, parseEventSourceSubtype } = require('./trigger')

/** @typedef {import('../../../index').SpanOptions} SpanOptions */

class SpanInferrer {
  #tracer
  #config

  /**
   * @param {import('../../dd-trace/src/opentracing/tracer')} tracer Core tracer.
   * @param {object} config Resolved Lambda naming configuration.
   * @param {Record<string, string>} config.serviceMapping Core service mapping.
   * @param {string|undefined} config.service Unnormalized source DD_SERVICE, also used as peer.service.
   * @param {boolean} config.serviceRepresentationEnabled Resource-based AWS service names.
   * @param {boolean} config.removeIntegrationServiceNamesEnabled Use DD_SERVICE for synthetic services.
   */
  constructor (tracer, config) {
    this.#tracer = tracer
    this.#config = config
  }

  /** @param {string} serviceName Specific resource or generic integration key. */
  getServiceMapping (serviceName) {
    const mapped = this.#config.serviceMapping?.[serviceName]
    // The shim ignores identity mappings, empty keys and values containing another colon.
    if (serviceName && mapped && mapped !== serviceName && !mapped.includes(':')) return mapped
  }

  /**
   * @param {string} name Span name.
   * @param {SpanOptions} options Native span options.
   * @param {boolean} isAsync End at invocation start rather than completion.
   * @returns {{ span: import('../../dd-trace/src/opentracing/span'), isAsync: boolean }}
   */
  #startSpan (name, options, isAsync) {
    return { span: this.#tracer.startSpan(name, options), isAsync }
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   * @param {boolean} [decodeAuthorizerContext] Decode uncached authorizer context.
   */
  createInferredSpan (event, context, parentSpanContext, decodeAuthorizerContext = true) {
    const eventSource = parseEventSource(event)
    if (eventSource === eventTypes.lambdaUrl) {
      return this.createInferredSpanForLambdaUrl(event, context, parentSpanContext)
    }
    if (eventSource === eventTypes.apiGateway) {
      return this.createInferredSpanForApiGateway(event, context, parentSpanContext, decodeAuthorizerContext)
    }
    if (eventSource === eventTypes.sns) {
      return this.createInferredSpanForSns(event, context, parentSpanContext)
    }
    if (eventSource === eventTypes.dynamoDB) {
      return this.createInferredSpanForDynamoDBStreamEvent(event, context, parentSpanContext)
    }
    if (eventSource === eventTypes.sqs) {
      return this.createInferredSpanForSqs(event, context, parentSpanContext)
    }
    if (eventSource === eventTypes.kinesis) {
      return this.createInferredSpanForKinesis(event, context, parentSpanContext)
    }
    if (eventSource === eventTypes.s3) {
      return this.createInferredSpanForS3(event, context, parentSpanContext)
    }
    if (eventSource === eventTypes.eventBridge) {
      return this.createInferredSpanForEventBridge(event, context, parentSpanContext)
    }
  }

  /** @param {Record<string, unknown>} event API Gateway event. */
  isApiGatewayAsync (event) {
    if (event.headers && event.headers['X-Amz-Invocation-Type'] && event.headers['X-Amz-Invocation-Type'] === 'Event') {
      return 'async'
    }
    return 'sync'
  }

  /**
   * @param {string} specificKey AWS resource key.
   * @param {string} genericKey Integration mapping key.
   * @param {string} extractedKey Resource service name.
   * @param {string} fallback Legacy service name.
   */
  determineServiceName (specificKey, genericKey, extractedKey, fallback) {
    const mappedService = this.getServiceMapping(specificKey) || this.getServiceMapping(genericKey)
    if (mappedService) return mappedService
    const service = this.#config.service?.trim()
    if (this.#config.removeIntegrationServiceNamesEnabled && service) return service
    if (this.#config.serviceRepresentationEnabled === false) return fallback
    return extractedKey?.trim() ? extractedKey : fallback
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   * @param {boolean} [decodeAuthorizerContext] Decode uncached authorizer context.
   */
  createInferredSpanForApiGateway (event, context, parentSpanContext, decodeAuthorizerContext = true) {
    const options = {}
    const domain = event.requestContext.domainName || ''
    const path = event.rawPath || event.requestContext.path || event.requestContext.routeKey
    const httpUrl = `https://${domain}${path}`
    const resourcePath = this.getResourcePath(event)
    let method
    if (event.requestContext.httpMethod) {
      method = event.requestContext.httpMethod
    } else if (event.requestContext.http) {
      method = event.requestContext.http.method
    }
    const resourceName = `${method || domain} ${resourcePath ?? ''}`
    const apiId = event.requestContext.apiId || ''
    const serviceName = this.determineServiceName(apiId, 'lambda_api_gateway', domain, domain)
    options.tags = {
      'http.url': httpUrl,
      endpoint: path,
      resource_names: resourceName,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'web',
      'resource.name': resourceName,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      apiid: apiId,
      _inferred_span: {
        tag_source: 'self',
        synchronicity: this.isApiGatewayAsync(event),
      },
    }
    // Set APIGW v1 or v1 metadata
    if (method) {
      options.tags['http.method'] = method
      options.tags.stage = event.requestContext.stage
      options.tags.domain_name = domain
    }
    // Set websocket metadata
    if (event.requestContext.messageDirection) {
      options.tags.message_direction = event.requestContext.messageDirection
      options.tags.connection_id = event.requestContext.connectionId
      options.tags.event_type = event.requestContext.eventType
    }
    let upstreamAuthorizerSpan
    const eventSourceSubtype = parseEventSourceSubtype(event)
    if (decodeAuthorizerContext) {
      try {
        const parsedUpstreamContext = getInjectedAuthorizerHeaders(event)
        if (parsedUpstreamContext) {
          let upstreamSpanOptions = {}
          const startTime = parsedUpstreamContext[PARENT_SPAN_FINISH_TIME_HEADER] / 1e6
          // getting an approximated endTime
          if (eventSourceSubtype === eventSubTypes.apiGatewayV2) {
            options.startTime = startTime // not inserting authorizer span
          } else {
            upstreamSpanOptions = {
              startTime,
              childOf: parentSpanContext,
              tags: { ...options.tags },
            }
            upstreamAuthorizerSpan = this.#startSpan('aws.apigateway.authorizer', upstreamSpanOptions, false)
            const endTime = Math.max(
              startTime,
              event.requestContext.requestTimeEpoch + event.requestContext.authorizer.integrationLatency
            )
            upstreamAuthorizerSpan.span.finish(endTime)
            options.startTime = endTime // For the main function's inferred span
          }
        }
      } catch (error) {
        log.debug('Error decoding authorizer span: %s', error)
      }
    }
    if (!options.startTime) {
      if (eventSourceSubtype === eventSubTypes.apiGatewayV1 ||
          eventSourceSubtype === eventSubTypes.apiGatewayWebsocket) {
        options.startTime = event.requestContext.requestTimeEpoch
      } else {
        options.startTime = event.requestContext.timeEpoch
      }
    }
    // Compute API Gateway ARN for dd_resource_key
    if (context?.invokedFunctionArn && apiId) {
      const { region } = parseLambdaARN(context.invokedFunctionArn)
      if (region) {
        const apiGatewayArn = eventSourceSubtype === eventSubTypes.apiGatewayV2
          ? `arn:aws:apigateway:${region}::/apis/${apiId}`
          : `arn:aws:apigateway:${region}::/restapis/${apiId}`
        options.tags.dd_resource_key = apiGatewayArn
      }
    }
    options.childOf = upstreamAuthorizerSpan ? upstreamAuthorizerSpan.span : parentSpanContext
    const isAsync = this.isApiGatewayAsync(event) === 'async'
    const spanName = eventSourceSubtype === eventSubTypes.apiGatewayV2 ? 'aws.httpapi' : 'aws.apigateway'
    return this.#startSpan(spanName, options, isAsync)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForLambdaUrl (event, context, parentSpanContext) {
    const options = {}
    const domain = event.requestContext.domainName || ''
    const path = event.rawPath
    const httpUrl = `https://${domain}${path}`
    let method
    if (event.requestContext.httpMethod) {
      method = event.requestContext.httpMethod
    } else if (event.requestContext.http) {
      method = event.requestContext.http.method
    }
    const resourceName = `${method || domain} ${path ?? ''}`
    const apiId = event.requestContext.apiId || ''
    const serviceName = this.determineServiceName(apiId, 'lambda_url', domain, domain)
    options.tags = {
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
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'sync',
      },
    }
    options.startTime = event.requestContext.timeEpoch
    if (parentSpanContext) {
      options.childOf = parentSpanContext
    }
    return this.#startSpan('aws.lambda.url', options, false)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForDynamoDBStreamEvent (event, context, parentSpanContext) {
    const options = {}
    const { Records } = event
    const referenceRecord = Records[0]
    const { eventSourceARN, eventName, eventVersion, eventID, dynamodb } = referenceRecord
    const [, tableName] = eventSourceARN?.split('/') || ['', '']
    const resourceName = `${eventName} ${tableName}`
    const serviceName = this.determineServiceName(tableName, 'lambda_dynamodb', tableName, 'aws.dynamodb')
    options.tags = {
      operation_name: 'aws.dynamodb',
      tablename: tableName,
      resource_names: resourceName,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'web',
      'resource.name': resourceName,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'async',
      },
      event_name: eventName,
      event_version: eventVersion,
      event_source_arn: eventSourceARN,
      event_id: eventID,
    }
    if (dynamodb) {
      options.tags.stream_view_type = dynamodb.StreamViewType
      options.tags.size_bytes = dynamodb.SizeBytes
    }
    if (parentSpanContext) {
      options.childOf = parentSpanContext
    }
    options.startTime = Number(referenceRecord.dynamodb?.ApproximateCreationDateTime) * 1000
    return this.#startSpan('aws.dynamodb', options, true)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForSns (event, context, parentSpanContext) {
    const options = {}
    let referenceRecord
    let eventSubscriptionArn = ''
    if (event.Records) {
      // Full SNS Event into Lambda
      const { Records } = event;
      ({ Sns: referenceRecord, EventSubscriptionArn: eventSubscriptionArn } = Records[0])
    } else {
      // SNS message wrapping an SQS message
      referenceRecord = event
    }
    const { TopicArn, Timestamp, Type, Subject, MessageId } = referenceRecord
    const topicName = TopicArn?.split(':').pop() || ''
    const resourceName = topicName
    const serviceName = this.determineServiceName(topicName, 'lambda_sns', topicName, 'sns')
    options.tags = {
      operation_name: 'aws.sns',
      resource_names: resourceName,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'sns',
      'resource.name': resourceName,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'async',
      },
      type: Type,
      subject: Subject,
      message_id: MessageId,
      topicname: topicName,
      topic_arn: TopicArn,
    }
    // EventSubscriptionARN not available for direct integrations to SQS from SNS.
    if (eventSubscriptionArn !== '') {
      options.tags.event_subscription_arn = eventSubscriptionArn
    }
    if (parentSpanContext) {
      options.childOf = parentSpanContext
    }
    options.startTime = Date.parse(Timestamp)
    return this.#startSpan('aws.sns', options, true)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForSqs (event, context, parentSpanContext) {
    const options = {}
    const { Records } = event
    const referenceRecord = Records[0]
    const {
      attributes: { SentTimestamp, ApproximateReceiveCount, SenderId }, eventSourceARN, receiptHandle, body,
    } = referenceRecord
    const queueName = eventSourceARN?.split(':').pop() || ''
    const resourceName = queueName
    const serviceName = this.determineServiceName(queueName, 'lambda_sqs', queueName, 'sqs')
    options.tags = {
      operation_name: 'aws.sqs',
      resource_names: resourceName,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'web',
      'resource.name': resourceName,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'async',
      },
      queuename: queueName,
      event_source_arn: eventSourceARN,
      receipt_handle: receiptHandle,
      sender_id: SenderId,
    }
    if (ApproximateReceiveCount && Number(ApproximateReceiveCount) > 0) {
      options.tags.retry_count = Number(ApproximateReceiveCount)
    }
    // Check if sqs message was from sns
    // If so, unpack and look at timestamp
    // create further upstream sns span and finish/attach it here
    let upstreamSpan = null
    try {
      const upstreamMessage = JSON.parse(body)
      if (upstreamMessage && upstreamMessage.TopicArn && upstreamMessage.Timestamp) {
        upstreamSpan = this.createInferredSpanForSns(upstreamMessage, context, parentSpanContext)
        upstreamSpan.span.finish(Number(SentTimestamp))
      } else if (upstreamMessage?.detail?._datadog) {
        upstreamSpan = this.createInferredSpanForEventBridge(upstreamMessage, context, parentSpanContext)
        upstreamSpan.span.finish(Number(SentTimestamp))
      }
    } catch {
      // Pass, it's a raw SQS message
    }
    options.childOf = upstreamSpan ? upstreamSpan.span : parentSpanContext
    options.startTime = Number(SentTimestamp)
    return this.#startSpan('aws.sqs', options, true)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForKinesis (event, context, parentSpanContext) {
    const options = {}
    const { Records } = event
    const referenceRecord = Records[0]
    const {
      kinesis: { approximateArrivalTimestamp, partitionKey }, eventSourceARN, eventName, eventVersion, eventID,
    } = referenceRecord
    const streamName = (eventSourceARN?.split(':').pop() || '').replace(/^stream\//, '')
    const shardId = eventID.split(':').pop()
    const serviceName = this.determineServiceName(streamName, 'lambda_kinesis', streamName, 'kinesis')
    options.tags = {
      operation_name: 'aws.kinesis',
      resource_names: streamName,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'web',
      'resource.name': streamName,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'async',
      },
      streamname: streamName,
      event_id: eventID,
      event_name: eventName,
      event_source_arn: eventSourceARN,
      event_version: eventVersion,
      partition_key: partitionKey,
      shardid: shardId,
    }
    if (parentSpanContext) {
      options.childOf = parentSpanContext
    }
    options.startTime = Number(approximateArrivalTimestamp) * 1000
    return this.#startSpan('aws.kinesis', options, true)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForS3 (event, context, parentSpanContext) {
    const options = {}
    const { Records } = event
    const referenceRecord = Records[0]
    const {
      s3: { bucket: { name: bucketName, arn }, object: { key, size, eTag } }, eventTime, eventName,
    } = referenceRecord
    const serviceName = this.determineServiceName(bucketName, 'lambda_s3', bucketName, 's3')
    options.tags = {
      operation_name: 'aws.s3',
      resource_names: bucketName,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'web',
      'resource.name': bucketName,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'async',
      },
      bucketname: bucketName,
      bucket_arn: arn,
      event_name: eventName,
      object_key: key,
      object_size: size,
      object_etag: eTag,
    }
    if (parentSpanContext) {
      options.childOf = parentSpanContext
    }
    options.startTime = Date.parse(eventTime)
    return this.#startSpan('aws.s3', options, true)
  }

  /**
   * @param {Record<string, unknown>} event Lambda trigger.
   * @param {Record<string, unknown>|undefined} context Lambda context.
   * @param {import('../../dd-trace/src/opentracing/span_context')|undefined} parentSpanContext Upstream context.
   */
  createInferredSpanForEventBridge (event, context, parentSpanContext) {
    const options = {}
    const { time, source } = event
    const serviceName = this.determineServiceName(source, 'lambda_eventbridge', source, 'eventbridge')
    options.tags = {
      operation_name: 'aws.eventbridge',
      resource_names: source,
      request_id: context?.awsRequestId,
      service: serviceName,
      'service.name': serviceName,
      'span.type': 'web',
      'resource.name': source,
      'peer.service': this.#config.service,
      'span.kind': 'server',
      _inferred_span: {
        tag_source: 'self',
        synchronicity: 'async',
      },
    }
    if (parentSpanContext) {
      options.childOf = parentSpanContext
    }
    options.startTime = Date.parse(time)
    return this.#startSpan('aws.eventbridge', options, true)
  }

  /** @param {Record<string, unknown>} event API Gateway event. */
  getResourcePath (event) {
    const routeKey = event?.requestContext?.routeKey
    if (routeKey && routeKey.includes('{')) {
      // this is a parameterized route
      try {
        return event.requestContext.routeKey.split(' ')[1]
      } catch (e) {
        log.debug('Error parsing routeKey: %s', e)
      }
    }
    return event.rawPath || event.requestContext.resourcePath || routeKey
  }
}
module.exports = SpanInferrer
