'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')
const log = require('../../dd-trace/src/log')

// WeakMap to track push receive spans by request
const pushReceiveSpans = new WeakMap()

class GoogleCloudPubsubPushSubscriptionPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-push-subscription' }

  constructor (...args) {
    super(...args)

    /**
     * PUSH SUBSCRIPTION: GCP sends HTTP POST requests to our service with message data in headers.
     * We intercept these requests to create a pubsub.push.receive span that wraps the HTTP request.
     *
     * Flow: Detect push request -> Extract trace context -> Create receive span -> Activate it
     * Hierarchy: pubsub.push.receive (parent) -> http.request (child) -> express.middleware...
     *
     * Plugin load order (http/index.js) ensures we subscribe before HttpServerPlugin.
     */
    this.addSub('apm:http:server:request:start', (ctx) => {
      this.#handlePubSubRequest(ctx)
    })

    this.addSub('apm:http:server:request:finish', ({ req }) => {
      this.#finishPushReceiveSpan(req)
    })
  }

  #finishPushReceiveSpan (req) {
    const pushReceiveSpan = pushReceiveSpans.get(req)
    if (pushReceiveSpan && !pushReceiveSpan._duration) {
      pushReceiveSpan.finish()
      pushReceiveSpans.delete(req)
    }
  }

  #handlePubSubRequest (ctx) {
    const { req } = ctx
    const userAgent = req.headers['user-agent'] || ''
    if (req.method !== 'POST' || !userAgent.includes('APIs-Google')) {
      return false
    }

    if (req.headers['x-goog-pubsub-message-id']) {
      this.#createPushReceiveSpanAndActivate(ctx)
      return true
    }

    log.warn(
      '[PubSub] No x-goog-pubsub-* headers detected. pubsub.push.receive spans will not be created. ' +
      'Add --push-no-wrapper-write-metadata to your subscription.'
    )
    return false
  }

  #createPushReceiveSpanAndActivate (ctx) {
    const { req, res } = ctx
    const messageData = this.#parseMessage(req)
    if (!messageData) {
      return
    }

    const originalContext = this.#extractContext(messageData)
    const pubsubRequestContext = this.#reconstructPubSubContext(messageData.attrs) || originalContext
    const isSameTrace = pubsubRequestContext &&
      originalContext?.toTraceId() === pubsubRequestContext.toTraceId()

    /**
     * Create receive span, choosing parent context:
     * - Same trace: use batch context (message is part of the batch trace)
     * - Different trace: use message context as parent, link to batch for observability
     *
     * this.enter() activates the span so the HTTP request span becomes its child.
     */
    const pushReceiveSpan = this.#createPushReceiveSpan(
      messageData,
      isSameTrace ? pubsubRequestContext : originalContext,
      isSameTrace ? null : pubsubRequestContext
    )

    if (!pushReceiveSpan) {
      return
    }

    this.enter(pushReceiveSpan, { req, res })
    pushReceiveSpans.set(req, pushReceiveSpan)
  }

  #parseMessage (req) {
    const subscription = req.headers['x-goog-pubsub-subscription-name']
    const message = {
      messageId: req.headers['x-goog-pubsub-message-id'],
      publishTime: req.headers['x-goog-pubsub-publish-time'],
    }

    const topicName = req.headers['pubsub.topic'] || 'push-subscription-topic'
    return { message, subscription, attrs: req.headers, topicName }
  }

  #extractContext (messageData) {
    return this.tracer.extract('text_map', messageData.attrs)
  }

  #reconstructPubSubContext (attrs) {
    /**
     * Reconstruct the batch publish span context from message attributes.
     *
     * When a batch is published, the producer injects:
     * - _dd.pubsub_request.trace_id: lower 64 bits of the batch span's trace ID (hex)
     * - _dd.pubsub_request.span_id: the batch span's span ID (hex)
     * - _dd.pubsub_request.p.tid: upper 64 bits of trace ID (hex, optional for 128-bit traces)
     *
     * This context represents the "pubsub.request" span on the producer side.
     * We use it to create span links, connecting each pubsub.push.receive span back to the original batch.
     */
    const traceIdLower = attrs['_dd.pubsub_request.trace_id']
    const spanId = attrs['_dd.pubsub_request.span_id']
    const traceIdUpper = attrs['_dd.pubsub_request.p.tid']

    if (!traceIdLower || !spanId) return null

    // Reconstruct full 128-bit trace ID (or pad 64-bit to 128-bit)
    const traceId128 = traceIdUpper ? traceIdUpper + traceIdLower : traceIdLower.padStart(32, '0')
    const traceId = id(traceId128, 16)
    const parentId = id(spanId, 16)

    const tags = {}
    if (traceIdUpper) tags['_dd.p.tid'] = traceIdUpper

    return new SpanContext({
      traceId,
      spanId: parentId,
      tags,
    })
  }

  #createPushReceiveSpan (messageData, parentContext, linkContext) {
    const { message, subscription, topicName, attrs } = messageData
    const subscriptionName = subscription?.slice(subscription.lastIndexOf('/') + 1) ?? subscription
    const publishStartTime = attrs['x-dd-publish-start-time']
    const startTime = publishStartTime ? Number.parseInt(publishStartTime, 10) : undefined

    // Get the base service name and construct the pubsub service override
    const baseService = this.tracer._service
    const serviceOverride = this.config.service ?? `${baseService}-pubsub`

    // Use this.startSpan() which automatically activates the span
    const span = this.startSpan('pubsub.push.receive', {
      childOf: parentContext,
      startTime,
      kind: 'consumer',
      service: serviceOverride,
      meta: {
        component: 'google-cloud-pubsub',
        'pubsub.method': 'receive',
        'pubsub.subscription': subscription,
        'pubsub.message_id': message.messageId,
        'pubsub.subscription_type': 'push',
        'pubsub.topic': topicName,
        '_dd.base_service': baseService,
        '_dd.serviceoverride.type': 'integration',
        'resource.name': `Push Subscription ${subscriptionName}`,
      },
    })

    if (!span) {
      return null
    }

    span._integrationName = 'google-cloud-pubsub'
    // Calculate delivery latency (queue time from publish to delivery)
    if (publishStartTime) {
      const deliveryDuration = Date.now() - Number(publishStartTime)
      span.setTag('pubsub.delivery_duration_ms', deliveryDuration)
    }

    this.#addBatchMetadata(span, attrs)

    if (linkContext) {
      if (span.addLink) {
        span.addLink(linkContext, {})
      } else {
        span._links ??= []
        span._links.push({ context: linkContext, attributes: {} })
      }
    }

    return span
  }

  #addBatchMetadata (span, attrs) {
    const batchSizeStr = attrs['_dd.batch.size']
    const batchIndexStr = attrs['_dd.batch.index']

    if (!batchSizeStr || batchIndexStr === undefined) return

    const size = Number(batchSizeStr)
    const index = Number(batchIndexStr)

    span.setTag('pubsub.batch.message_count', size)
    span.setTag('pubsub.batch.message_index', index)
    span.setTag('pubsub.batch.description', `Message ${index + 1} of ${size}`)

    const requestTraceId = attrs['_dd.pubsub_request.trace_id']
    if (requestTraceId) {
      span.setTag('pubsub.batch.request_trace_id', requestTraceId)
    }
  }
}

module.exports = GoogleCloudPubsubPushSubscriptionPlugin
