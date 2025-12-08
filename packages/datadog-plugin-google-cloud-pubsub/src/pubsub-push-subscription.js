'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const log = require('../../dd-trace/src/log')
const { storage } = require('../../datadog-core')
const { channel } = require('../../datadog-instrumentations/src/helpers/instrument')
const tracer = require('../../dd-trace')

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
    const userAgent = req.headers['user-agent'] || ''
    if (req.method !== 'POST' || !userAgent.includes('APIs-Google')) return
    // Check for unwrapped Pub/Sub format (--push-no-wrapper-write-metadata)
    if (req.headers['x-goog-pubsub-message-id']) {
      log.debug('[PubSub] Detected unwrapped Pub/Sub push subscription')
      this._createDeliverySpanAndActivate({ req, res })
    } else {
      log.warn(
        '[PubSub] No x-goog-pubsub-* headers detected. pubsub.delivery spans will not be created. ' +
        'Add --push-no-wrapper-write-metadata to your subscription.'
      )
    }
  }

  _createDeliverySpanAndActivate ({ req, res }) {
    const messageData = this._parseMessage(req)
    if (!messageData) return

    if (!tracer || !tracer._tracer) return

    const parentContext = tracer._tracer.extract('text_map', messageData.attrs) || undefined
    const deliverySpan = this._createDeliverySpan(messageData, parentContext, tracer)
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

    const topicName = req.headers['pubsub.topic'] || 'push-subscription-topic'
    return { message, subscription, attrs: req.headers, topicName }
  }

  _createDeliverySpan (messageData, parentContext, tracer) {
    const { message, subscription, topicName } = messageData
    const subscriptionName = subscription.split('/').pop() || subscription

    const span = tracer._tracer.startSpan('pubsub.delivery', {
      childOf: parentContext,
      integrationName: 'google-cloud-pubsub',
      tags: {
        'span.kind': 'consumer',
        component: 'google-cloud-pubsub',
        '_dd.integration': 'google-cloud-pubsub',
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

    return span
  }
}

module.exports = GoogleCloudPubsubPushSubscriptionPlugin
