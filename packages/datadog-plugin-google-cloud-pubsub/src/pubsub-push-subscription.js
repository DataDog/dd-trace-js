'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const log = require('../../dd-trace/src/log')
const { storage } = require('../../datadog-core')
const { channel } = require('../../datadog-instrumentations/src/helpers/instrument')

class GoogleCloudPubsubPushSubscriptionPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-push-subscription' }

  constructor (...args) {
    super(...args)

    // Subscribe to HTTP start channel to intercept PubSub requests
    // We run BEFORE HTTP plugin to set delivery span as active parent
    const startCh = channel('apm:http:server:request:start')
    startCh.subscribe(({ req, res }) => {
      this._handlePubSubRequest({ req, res })
    })
  }

  _handlePubSubRequest ({ req, res }) {
    // Only check POST requests
    if (req.method !== 'POST') return

    // Check for unwrapped Pub/Sub format (--push-no-wrapper-write-metadata)
    // NOTE: Only unwrapped headers will work. Standard wrapped format requires
    // body parsing which hasn't happened yet at this point in the request lifecycle.
    if (req.headers['x-goog-pubsub-message-id']) {
      log.debug('[PubSub] Detected unwrapped Pub/Sub format (push subscription)')
      this._createDeliverySpanAndActivate({ req, res })
    }
  }

  _createDeliverySpanAndActivate ({ req, res }) {
    const messageData = this._parseMessage(req)
    if (!messageData) return // No valid message data

    // Get tracer lazily - it will be initialized by the time requests arrive
    const tracer = this.tracer || require('../../dd-trace')
    if (!tracer || !tracer._tracer) return

    const parentContext = this._extractContext(messageData, tracer)
    const deliverySpan = this._createDeliverySpan(messageData, parentContext, tracer)

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

  _parseMessage (req) {
    // ONLY check for unwrapped headers - body parsing happens later in middleware
    // This runs at apm:http:server:request:start, BEFORE express.json/body-parser
    // Requires --push-no-wrapper-write-metadata flag on the push subscription
    const subscription = req.headers['x-goog-pubsub-subscription-name']
    const message = {
      messageId: req.headers['x-goog-pubsub-message-id'],
      publishTime: req.headers['x-goog-pubsub-publish-time']
    }

    const { projectId, topicName } = this._extractProjectTopic(req.headers, subscription)
    return { message, subscription, attrs: req.headers, projectId, topicName }
  }

  _extractContext (messageData, tracer) {
    // messageData.attrs is req.headers, so just extract from there
    // Use the actual tracer instance (_tracer) for proper 128-bit trace ID extraction
    return tracer._tracer.extract('text_map', messageData.attrs) || undefined
  }

  _createDeliverySpan (messageData, parentContext, tracer) {
    const { message, subscription, topicName, attrs } = messageData

    const subscriptionName = subscription.split('/').pop() || subscription

    // Extract publish time from custom header (set by producer after gRPC call completes)
    // This ensures delivery span starts AFTER grpc.client and represents full delivery latency
    const publishStartTime = attrs['x-dd-publish-start-time']
    const startTime = publishStartTime ? Number.parseInt(publishStartTime, 10) : undefined

    const span = tracer._tracer.startSpan('pubsub.delivery', {
      childOf: parentContext,
      startTime, // Start span at publish time (in milliseconds)
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

    // Set resource name using setTag (raw tracer doesn't support resource in startSpan options)
    span.setTag('resource.name', `Push Subscription ${subscriptionName}`)

    return span
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
