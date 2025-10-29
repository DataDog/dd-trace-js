'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const web = require('../../dd-trace/src/plugins/util/web')
const { getSharedChannel } = require('../../datadog-instrumentations/src/shared-channels')

class GoogleCloudPubsubTransitHandlerPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-transit-handler' }

  constructor (...args) {
    super(...args)
    const channel = getSharedChannel('apm:http:server:request:intercept')
    channel.subscribe(this.handleRequestIntercept.bind(this))
  }

  handleRequestIntercept (interceptData) {
    const { req } = interceptData
    const isPubSub = req.method === 'POST' && (
      req.headers['user-agent']?.includes('APIs-Google') ||
      Object.keys(req.headers).some(k => k.toLowerCase().startsWith('x-goog-pubsub-'))
    )
    const isCloudEvent = req.method === 'POST' && req.headers['ce-specversion']

    if (!isPubSub && !isCloudEvent) return

    interceptData.handled = true
    this._processPubSubRequest(interceptData, isCloudEvent)
  }

  _processPubSubRequest ({ req, res, emit, server }, isCloudEvent) {
    const messageData = this._parseMessage(req, isCloudEvent)
    const parent = this._extractContext(messageData, req)

    // Create HTTP span (no delivery span in Branch 1)
    const httpSpan = this.tracer.startSpan('http.request', {
      childOf: parent,
      tags: {
        'http.method': req.method,
        'http.url': `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${req.url}`,
        'span.kind': 'server',
        component: 'http',
        'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push'
      }
    })
    httpSpan.setTag('service.name', this.tracer._service)

    const finish = (err) => {
      if (httpSpan && !httpSpan.finished) {
        if (err) {
          httpSpan.setTag('error', true)
          if (err.message) httpSpan.setTag('error.message', err.message)
        } else {
          httpSpan.setTag('http.status_code', res.statusCode)
          if (res.statusCode >= 400) httpSpan.setTag('error', true)
        }
        httpSpan.finish()
      }
    }

    res.once('finish', () => finish())
    res.once('close', () => finish())
    res.once('error', finish)

    const context = web.patch(req)
    context.span = httpSpan
    context.tracer = this.tracer
    context.res = res

    this.tracer.scope().activate(httpSpan, () => emit.call(server, 'request', req, res))
  }

  _parseMessage (req, isCloudEvent) {
    // Check for unwrapped headers first
    const hasPubSubHeaders = Object.keys(req.headers).some(k => k.toLowerCase().startsWith('x-goog-pubsub-'))
    
    if (hasPubSubHeaders) {
      const subscription = req.headers['x-goog-pubsub-subscription-name']
      const message = {
        messageId: req.headers['x-goog-pubsub-message-id'],
        publishTime: req.headers['x-goog-pubsub-publish-time'],
        attributes: { ...req.headers }
      }
      const { projectId, topicName } = this._extractProjectTopic(message.attributes, subscription)
      return { message, subscription, attrs: message.attributes, projectId, topicName }
    }

    // Fall back to body parsing
    if (!req.body) return null

    try {
      if (isCloudEvent) {
        const message = req.body.message || req.body
        const attrs = message?.attributes && typeof message.attributes === 'object' 
          ? { ...message.attributes } 
          : {}
        const subscription = req.body.subscription || req.headers['ce-subscription'] || 'cloud-event-subscription'

        // Add CloudEvent headers
        if (!attrs.traceparent && (req.headers['ce-traceparent'] || req.headers.traceparent)) {
          attrs.traceparent = req.headers['ce-traceparent'] || req.headers.traceparent
        }
        if (!attrs.tracestate && (req.headers['ce-tracestate'] || req.headers.tracestate)) {
          attrs.tracestate = req.headers['ce-tracestate'] || req.headers.tracestate
        }
        if (req.headers['ce-source']) attrs['ce-source'] = req.headers['ce-source']
        if (req.headers['ce-type']) attrs['ce-type'] = req.headers['ce-type']

        const { projectId, topicName } = this._extractProjectTopic(attrs, subscription)
        return { message, subscription, attrs, projectId, topicName }
      } else {
        const message = req.body.message
        const subscription = req.body.subscription
        const attrs = message?.attributes && typeof message.attributes === 'object' 
          ? message.attributes 
          : {}

        const { projectId, topicName } = this._extractProjectTopic(attrs, subscription)
        return { message, subscription, attrs, projectId, topicName }
      }
    } catch (err) {
      return null
    }
  }

  _extractContext (messageData, req) {
    if (messageData?.attrs) {
      const context = this.tracer.extract('text_map', messageData.attrs)
      if (context) return context
    }

    // Fallback to headers
    const carrier = {}
    if (req.headers.traceparent) carrier.traceparent = req.headers.traceparent
    if (req.headers.tracestate) carrier.tracestate = req.headers.tracestate
    if (req.headers['ce-traceparent']) carrier.traceparent = req.headers['ce-traceparent']
    if (req.headers['ce-tracestate']) carrier.tracestate = req.headers['ce-tracestate']
    
    for (const k of ['x-datadog-trace-id', 'x-datadog-parent-id', 'x-datadog-sampling-priority', 'x-datadog-tags']) {
      if (req.headers[k]) carrier[k] = req.headers[k]
    }

    return this.tracer.extract('text_map', carrier) || undefined
  }

  _extractProjectTopic (attrs, subscription) {
    let projectId = attrs['gcloud.project_id']
    let topicName = attrs['pubsub.topic']

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

module.exports = GoogleCloudPubsubTransitHandlerPlugin
