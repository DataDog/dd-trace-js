'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const web = require('../../dd-trace/src/plugins/util/web')
const { getSharedChannel } = require('../../datadog-instrumentations/src/shared-channels')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const id = require('../../dd-trace/src/id')

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
    const originalContext = this._extractContext(messageData, req)
    const pubsubRequestContext = messageData?.attrs 
      ? this._reconstructPubSubContext(messageData.attrs) || originalContext
      : originalContext

    // Determine parent for delivery span
    let deliverySpan = null
    if (messageData) {
      const isSameTrace = originalContext && pubsubRequestContext &&
        originalContext.toTraceId() === pubsubRequestContext.toTraceId()
      
      deliverySpan = this._createDeliverySpan(
        messageData,
        isCloudEvent,
        isSameTrace ? pubsubRequestContext : originalContext,
        !isSameTrace // Add span link only if different trace
      )
    }

    // Create http span as child
    const httpSpan = this.tracer.startSpan('http.request', {
      childOf: deliverySpan || originalContext,
      tags: {
        'http.method': req.method,
        'http.url': `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${req.url}`,
        'span.kind': 'server',
        component: 'http',
        'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push'
      }
    })
<<<<<<< Updated upstream
    try { httpSpan.setTag('service.name', this.tracer._service) } catch {}
=======
    httpSpan.setTag('service.name', this.tracer._service)

    // Finish spans when response completes
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
      if (deliverySpan && !deliverySpan.finished) {
        if (err) deliverySpan.setTag('error', true)
        deliverySpan.finish()
      }
    }
>>>>>>> Stashed changes

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
        const attrs = message?.attributes && message.attributes !== null && typeof message.attributes === 'object'
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
      }
      const message = req.body.message
      const subscription = req.body.subscription
      const attrs = message?.attributes && message.attributes !== null && typeof message.attributes === 'object'
        ? message.attributes
        : {}

      const { projectId, topicName } = this._extractProjectTopic(attrs, subscription)
      return { message, subscription, attrs, projectId, topicName }
    } catch {
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

  _reconstructPubSubContext (attrs) {
    const traceIdHex = attrs['_dd.pubsub_request.trace_id']
    const spanIdHex = attrs['_dd.pubsub_request.span_id']
    if (!traceIdHex || !spanIdHex) return null

    // Convert hex to decimal for SpanContext (dd-trace uses decimal internally)
    const traceIdDec = BigInt('0x' + traceIdHex).toString(10)
    const spanIdDec = BigInt('0x' + spanIdHex).toString(10)

    const context = new SpanContext({
      traceId: id(traceIdDec, 10),
      spanId: id(spanIdDec, 10)
    })
    
    if (attrs['_dd.pubsub_request.p.tid']) {
      context._trace.tags['_dd.p.tid'] = attrs['_dd.pubsub_request.p.tid']
    }
    if (attrs['x-datadog-sampling-priority']) {
      context._sampling = { priority: parseInt(attrs['x-datadog-sampling-priority'], 10) }
    }
    
    return context
  }

  _createDeliverySpan (messageData, isCloudEvent, parent, addSpanLink) {
    const { attrs, topicName, subscription, message } = messageData
    const messageId = message?.messageId || attrs['ce-id']

    // Calculate scheduling duration
    const publishTime = attrs['x-dd-publish-start-time']
    const schedulingMs = publishTime ? Date.now() - parseInt(publishTime, 10) : null

    const spanTags = {
      component: 'google-cloud-pubsub',
      'span.kind': 'consumer',
      operation: 'pubsub.delivery',
      'pubsub.topic': topicName,
      'pubsub.subscription': subscription,
      'pubsub.message_id': messageId,
      'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push',
      '_dd.base_service': this.tracer._service,
      '_dd.serviceoverride.type': 'integration'
    }

    if (schedulingMs) spanTags['pubsub.delivery_duration_ms'] = schedulingMs

    // Add span link and batch metadata
    const spanLinkContext = this._addSpanLinkMetadata(spanTags, attrs, addSpanLink)
    this._addBatchMetadata(spanTags, attrs)

    // Add CloudEvent tags
    if (isCloudEvent) {
      ['ce-source', 'ce-type', 'ce-id', 'ce-specversion', 'ce-time'].forEach(k => {
        if (attrs[k]) spanTags[`cloudevents.${k.replace('ce-', '')}`] = attrs[k]
      })
      spanTags['eventarc.trigger'] = 'pubsub'
    }

    const span = this.tracer.startSpan('pubsub.delivery', {
      resource: `${topicName} → ${subscription}`,
      type: 'worker',
      tags: spanTags,
      childOf: parent,
      startTime: publishTime ? parseInt(publishTime, 10) : undefined
    })
    
    span.setTag('service.name', this.config.service || `${this.tracer._service}-pubsub`)
    
    // Add OpenTelemetry span link
    if (spanLinkContext) {
      span._links = span._links || []
      if (typeof span.addLink === 'function') {
        span.addLink(spanLinkContext, {})
      } else {
        span._links.push({ context: spanLinkContext, attributes: {} })
      }
    }
    
    // Preserve sampling priority
    if (parent?._sampling?.priority !== undefined) {
      span.context()._sampling.priority = parent._sampling.priority
    }

    return span
  }

  _addSpanLinkMetadata (spanTags, attrs, addSpanLink) {
    const traceIdLowerHex = attrs['_dd.pubsub_request.trace_id']
    const traceIdUpper = attrs['_dd.pubsub_request.p.tid']
    const spanIdHex = attrs['_dd.pubsub_request.span_id']
    
    if (!traceIdLowerHex || !spanIdHex) return null

    // Values are already in hex - just combine upper + lower for full 128-bit
    const traceIdHex = traceIdUpper ? traceIdUpper + traceIdLowerHex : traceIdLowerHex.padStart(32, '0')

    spanTags['_dd.pubsub_request.trace_id'] = traceIdHex
    spanTags['_dd.pubsub_request.span_id'] = spanIdHex

    if (addSpanLink) {
      spanTags['_dd.span_links'] = JSON.stringify([{
        trace_id: traceIdHex,
        span_id: spanIdHex
      }])
      
      try {
        // Convert hex to decimal for SpanContext
        return new SpanContext({
          traceId: id(BigInt('0x' + traceIdHex.slice(-16)).toString(10), 10),
          spanId: id(BigInt('0x' + spanIdHex).toString(10), 10)
        })
      } catch (err) {
        return null
      }
    }
    
    return null
  }

  _addBatchMetadata (spanTags, attrs) {
    const size = attrs['_dd.batch.size']
    const index = attrs['_dd.batch.index']
    if (!size || index === undefined) return

    const sizeNum = parseInt(size, 10)
    const indexNum = parseInt(index, 10)
    
    spanTags['pubsub.batch.size'] = sizeNum
    spanTags['pubsub.batch.index'] = indexNum
    spanTags['pubsub.batch.description'] = `Message ${indexNum + 1} of ${sizeNum}`
    
    if (attrs['_dd.pubsub_request.span_id']) {
      spanTags['pubsub.batch.request_span_id'] = attrs['_dd.pubsub_request.span_id']
    }
    if (attrs['_dd.pubsub_request.trace_id']) {
      spanTags['pubsub.batch.request_trace_id'] = attrs['_dd.pubsub_request.trace_id']
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
<<<<<<< Updated upstream

    return { projectId, topicName }
=======
>>>>>>> Stashed changes
  }
}

module.exports = GoogleCloudPubsubTransitHandlerPlugin
