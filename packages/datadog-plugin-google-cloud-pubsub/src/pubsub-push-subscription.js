'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')
const log = require('../../dd-trace/src/log')
const { storage } = require('../../datadog-core')
const { channel } = require('../../datadog-instrumentations/src/helpers/instrument')

class GoogleCloudPubsubPushSubscriptionPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-push-subscription' }

  constructor (...args) {
    super(...args)

    const startCh = channel('apm:http:server:request:start')
    startCh.subscribe(({ req, res }) => {
      this._handlePubSubRequest({ req, res })
    })
  }

  _handlePubSubRequest ({ req, res }) {
    const userAgent = req.headers['user-agent'] || ''
    if (req.method !== 'POST' || !userAgent.includes('APIs-Google')) return

    if (req.headers['x-goog-pubsub-message-id']) {
      log.warn('[PubSub] Detected unwrapped Pub/Sub format (push subscription)')
      log.warn(`[PubSub] message-id: ${req.headers['x-goog-pubsub-message-id']}`)
      this._createDeliverySpanAndActivate({ req, res })
      return
    }

    log.warn(
      '[PubSub] No x-goog-pubsub-* headers detected. pubsub.delivery spans will not be created. ' +
      'Add --push-no-wrapper-write-metadata to your subscription.'
    )
  }

  _createDeliverySpanAndActivate ({ req, res }) {
    const messageData = this._parseMessage(req)
    if (!messageData) return

    const tracer = this.tracer || require('../../dd-trace')
    if (!tracer || !tracer._tracer) return

    const originalContext = this._extractContext(messageData, tracer)
    const pubsubRequestContext = this._reconstructPubSubContext(messageData.attrs) || originalContext

    const isSameTrace = originalContext && pubsubRequestContext &&
      originalContext.toTraceId() === pubsubRequestContext.toTraceId()

    const deliverySpan = this._createDeliverySpan(
      messageData,
      isSameTrace ? pubsubRequestContext : originalContext,
      !isSameTrace ? pubsubRequestContext : null,
      tracer
    )

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

    const store = storage('legacy').getStore()
    storage('legacy').enterWith({ ...store, span: deliverySpan, req, res })
  }

  _parseMessage (req) {
    const subscription = req.headers['x-goog-pubsub-subscription-name']
    const message = {
      messageId: req.headers['x-goog-pubsub-message-id'],
      publishTime: req.headers['x-goog-pubsub-publish-time']
    }

    const { projectId, topicName } = this._extractProjectTopic(req.headers, subscription)
    return { message, subscription, attrs: req.headers, projectId, topicName }
  }

  _extractContext (messageData, tracer) {
    return tracer._tracer.extract('text_map', messageData.attrs) || undefined
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

  _createDeliverySpan (messageData, parentContext, linkContext, tracer) {
    const { message, subscription, topicName, attrs } = messageData
    const subscriptionName = subscription.split('/').pop() || subscription

    const publishStartTime = attrs['x-dd-publish-start-time']
    const startTime = publishStartTime ? Number.parseInt(publishStartTime, 10) : undefined

    const span = tracer._tracer.startSpan('pubsub.delivery', {
      childOf: parentContext,
      startTime,
      tags: {
        'span.kind': 'consumer',
        component: 'google-cloud-pubsub',
        'pubsub.method': 'delivery',
        'pubsub.subscription': subscription,
        'pubsub.message_id': message.messageId,
        'pubsub.delivery_method': 'push',
        'pubsub.topic': topicName,
        service: this.config.service || `${tracer._tracer._service}-pubsub`,
        '_dd.base_service': tracer._tracer._service,
        '_dd.serviceoverride.type': 'integration'
      }
    })

    span.setTag('resource.name', `Push Subscription ${subscriptionName}`)
    this._addBatchMetadata(span, attrs)

    if (linkContext) {
      if (typeof span.addLink === 'function') {
        span.addLink(linkContext, {})
      } else {
        span._links = span._links || []
        span._links.push({ context: linkContext, attributes: {} })
      }
    }

    return span
  }

  _addBatchMetadata (span, attrs) {
    const batchSize = attrs['_dd.batch.size']
    const batchIndex = attrs['_dd.batch.index']

    if (batchSize && batchIndex !== undefined) {
      const size = Number.parseInt(batchSize, 10)
      const index = Number.parseInt(batchIndex, 10)

      span.setTag('pubsub.batch.message_count', size)
      span.setTag('pubsub.batch.message_index', index)
      span.setTag('pubsub.batch.description', `Message ${index + 1} of ${size}`)

      const requestTraceId = attrs['_dd.pubsub_request.trace_id']
      const requestSpanId = attrs['_dd.pubsub_request.span_id']

      if (requestTraceId) {
        span.setTag('pubsub.batch.request_trace_id', requestTraceId)
      }
      if (requestSpanId) {
        span.setTag('pubsub.batch.request_span_id', requestSpanId)
      }
    }
  }

  _extractProjectTopic (attrs, subscription) {
    const topicName = attrs['pubsub.topic']
    const projectId = subscription.match(/projects\/([^\\/]+)\/subscriptions/)
    return {
      projectId,
      topicName: topicName || 'push-subscription-topic'
    }
  }
}

module.exports = GoogleCloudPubsubPushSubscriptionPlugin
