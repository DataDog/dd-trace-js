'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')
const { storage } = require('../../datadog-core')
const { channel } = require('../../datadog-instrumentations/src/helpers/instrument')

class GoogleCloudPubsubPushSubscriptionPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-push-subscription' }

  constructor (...args) {
    super(...args)

    // Subscribe to HTTP start channel to intercept PubSub/CloudEvent requests
    // We run BEFORE HTTP plugin to set delivery span as active parent
    const startCh = channel('apm:http:server:request:start')
    startCh.subscribe(({ req, res }) => {
      this._handlePubSubRequest({ req, res })
    })
  }

  _handlePubSubRequest ({ req, res }) {
    // Only check POST requests
    if (req.method !== 'POST') return

    // NOTE: Only unwrapped headers (--push-no-wrapper-write-metadata) will work.
    // Standard wrapped format requires body parsing which hasn't happened yet.
    const isPubSub = req.headers['user-agent']?.includes('APIs-Google') ||
      req.headers['x-goog-pubsub-message-id']

    const isCloudEvent = req.headers['ce-specversion']

    if (!isPubSub && !isCloudEvent) return

    // Create delivery span and set as active
    // HTTP plugin will automatically create http.request as child
    // NOTE: Will only succeed if message data is in headers (unwrapped format)
    this._createDeliverySpanAndActivate({ req, res }, isCloudEvent)
  }

  _createDeliverySpanAndActivate ({ req, res }, isCloudEvent) {
    const messageData = this._parseMessage(req, isCloudEvent)
    if (!messageData) return // No valid message data

    const originalContext = this._extractContext(messageData)
    const pubsubRequestContext = this._reconstructPubSubContext(messageData.attrs) || originalContext

    const isSameTrace = originalContext && pubsubRequestContext &&
      originalContext.toTraceId() === pubsubRequestContext.toTraceId()

    const deliverySpan = this._createDeliverySpan(
      messageData,
      messageData.isCloudEvent || isCloudEvent,
      isSameTrace ? pubsubRequestContext : originalContext,
      !isSameTrace // Add span link only if different trace
    )

    // Finish delivery span when response completes
    const finishDelivery = () => {
      if (!deliverySpan.finished) {
        deliverySpan.finish()
      }
    }

    res.once('finish', finishDelivery)
    res.once('close', finishDelivery)
    res.once('error', (err) => {
      deliverySpan.setTag('error', err)
      finishDelivery()
    })

    // Set delivery span as active in async storage
    // HTTP plugin will create http.request span as child automatically
    const store = storage('legacy').getStore()
    storage('legacy').enterWith({ ...store, span: deliverySpan, req, res })
  }

  _parseMessage (req, isCloudEvent) {
    // ONLY check for unwrapped headers - body parsing happens later in middleware
    // This runs at apm:http:server:request:start, BEFORE express.json/body-parser
    //
    // Two header-based formats work:
    // 1. Pub/Sub unwrapped (--push-no-wrapper-write-metadata)
    // 2. CloudEvents with ce-* headers

    // Check for Pub/Sub unwrapped headers
    const hasPubSubHeaders = req.headers['x-goog-pubsub-message-id']

    if (hasPubSubHeaders) {
      const subscription = req.headers['x-goog-pubsub-subscription-name']
      const message = {
        messageId: req.headers['x-goog-pubsub-message-id'],
        publishTime: req.headers['x-goog-pubsub-publish-time']
      }
      const { projectId, topicName } = this._extractProjectTopic(req.headers, subscription)
      return { message, subscription, attrs: req.headers, projectId, topicName }
    }

    // Check for CloudEvents with headers (ce-* headers contain metadata)
    if (isCloudEvent && req.headers['ce-id']) {
      const subscription = req.headers['ce-subscription'] || req.headers['ce-source'] || 'cloudevent-subscription'
      const message = {
        messageId: req.headers['ce-id'],
        publishTime: req.headers['ce-time']
      }

      const { projectId, topicName } = this._extractProjectTopic(req.headers, subscription)
      return { message, subscription, attrs: req.headers, projectId, topicName, isCloudEvent: true }
    }

    // No headers = wrapped message format = body not available yet = no delivery span
    return null
  }

  _extractContext (messageData) {
    // messageData.attrs is req.headers, so just extract from there
    return this.tracer.extract('text_map', messageData.attrs) || undefined
  }

  _reconstructPubSubContext (attrs) {
    const traceIdLower = attrs['_dd.pubsub_request.trace_id']
    const spanId = attrs['_dd.pubsub_request.span_id']
    const traceIdUpper = attrs['_dd.pubsub_request.p.tid']

    if (!traceIdLower || !spanId) return null

    try {
      const traceId128 = traceIdUpper ? traceIdUpper + traceIdLower : traceIdLower.padStart(32, '0')
      const traceId = id(traceId128, 16)
      const parentId = id(spanId, 16)

      const tags = {}
      if (traceIdUpper) tags['_dd.p.tid'] = traceIdUpper

      return new SpanContext({
        traceId,
        spanId: parentId,
        tags
      })
    } catch {
      return null
    }
  }

  _createDeliverySpan (messageData, isCloudEvent, parentContext, addSpanLink) {
    const { message, subscription, projectId, topicName } = messageData

    const span = this.tracer.startSpan('pubsub.delivery', {
      childOf: parentContext,
      tags: {
        'span.kind': 'consumer',
        component: 'google-cloud-pubsub',
        'pubsub.method': 'delivery',
        'pubsub.topic': topicName,
        'pubsub.subscription': subscription,
        'pubsub.message_id': message.messageId,
        'gcloud.project_id': projectId,
        'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push',
        service: this.config.service || `${this.tracer._service}-pubsub`,
        '_dd.base_service': this.tracer._service,
        '_dd.serviceoverride.type': 'integration'
      }
    })

    // Add batch metadata if present
    this._addBatchMetadata(span, messageData.attrs)

    // Add OpenTelemetry span link
    if (addSpanLink && parentContext) {
      if (typeof span.addLink === 'function') {
        span.addLink(parentContext, {})
      } else {
        span._links = span._links || []
        span._links.push({ context: parentContext, attributes: {} })
      }
    }

    return span
  }

  _addBatchMetadata (span, attrs) {
    const batchSize = attrs['_dd.batch.size']
    const batchIndex = attrs['_dd.batch.index']

    if (batchSize && batchIndex !== undefined) {
      span.setTag('pubsub.batch.message_count', parseInt(batchSize, 10))
      span.setTag('pubsub.batch.message_index', parseInt(batchIndex, 10))
      span.setTag('pubsub.batch', true)
    }
  }

  _extractProjectTopic (attrs, subscription) {
    let projectId = attrs['gcloud.project_id']
    const topicName = attrs['pubsub.topic']

    if (!projectId && subscription) {
      const match = subscription.match(/projects\/([^\\/]+)\/subscriptions/)
      if (match) projectId = match[1]
    }

    return {
      projectId,
      topicName: topicName || 'push-subscription-topic'
    }
  }
}

module.exports = GoogleCloudPubsubPushSubscriptionPlugin
