'use strict'

// Datadog plugin for Google Cloud PubSub Transit handler
// Subscribes to the HTTP server request intercept channel and handles Pub/Sub push/CloudEvent requests.

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const web = require('../../dd-trace/src/plugins/util/web')
const { getSharedChannel } = require('../../datadog-instrumentations/src/shared-channels')

// Uses global req.body for message parsing when available

class GoogleCloudPubsubTransitHandlerPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-transit-handler' }

  constructor (...args) {
    super(...args)

    // Subscribe directly to the shared channel
    const sharedChannel = getSharedChannel('apm:http:server:request:intercept')
    const boundHandler = this.handleRequestIntercept.bind(this)
    sharedChannel.subscribe(boundHandler)

    // Store the handler for cleanup if needed
    this._directChannelHandler = boundHandler
    this._sharedChannel = sharedChannel
  }

  handleRequestIntercept (interceptData) {
    const { req, res, emit, server, originalArgs } = interceptData

    // Check if this is a PubSub or Cloud Event request
    const isCloudEvent = this.isCloudEventRequest(req)
    const isPubSub = this.isPubSubRequest(req)

    if (!isCloudEvent && !isPubSub) {
      // Not a PubSub request, let it continue normally
      return
    }

    // Mark as handled so HTTP server doesn't process it
    interceptData.handled = true

    // Process the PubSub request directly in the plugin
    this.processPubSubRequest(req, res, emit, server, originalArgs, isCloudEvent)
  }

  // Detection functions
  isPubSubRequest (req) {
    return req.method === 'POST' &&
      !!req.headers['content-type']?.includes('application/json') &&
      !!req.headers['user-agent']?.includes('APIs-Google')
  }

  isCloudEventRequest (req) {
    return req.method === 'POST' && !!req.headers['ce-specversion']
  }

  // Process PubSub/Cloud Event request directly in plugin
  processPubSubRequest (req, res, emit, server, originalArgs, isCloudEvent) {
    // Parse message data and extract tracing context
    const messageData = this.parseMessageData(req.body, req, isCloudEvent)
    const parent = this.extractTracingContext(messageData, req)

    const deliveryMethod = isCloudEvent ? 'eventarc' : 'push'

    const httpSpan = this.tracer.startSpan('http.request', {
      childOf: parent,
      tags: {
        'http.method': req.method,
        'http.url': `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${req.url}`,
        'span.kind': 'server',
        component: 'http',
        'pubsub.delivery_method': deliveryMethod
      }
    })
    httpSpan.setTag('service.name', this.tracer._service)

    // Create synthetic delivery span if message data is available
    if (messageData) {
      this.createDeliverySpan(messageData, isCloudEvent)
    }

    const finish = () => {
      if (httpSpan && !httpSpan.finished) {
        httpSpan.setTag('http.status_code', res.statusCode)
        if (res.statusCode >= 400) httpSpan.setTag('error', true)
        httpSpan.finish()
      }
    }
    res.once('finish', finish)
    res.once('close', finish)
    res.once('error', (e) => {
      if (httpSpan && !httpSpan.finished) {
        httpSpan.setTag('error', true)
        if (e && e.message) httpSpan.setTag('error.message', e.message)
        httpSpan.finish()
      }
    })

    const context = web.patch(req)
    context.span = httpSpan
    context.tracer = this.tracer
    context.res = res

    const scope = this.tracer.scope()
    scope.activate(httpSpan, () => emit.call(server, 'request', req, res))
  }

  // Parse message data from req.body
  parseMessageData (body, req, isCloudEvent) {
    if (!body) {
      const tracer = this.tracer || global._ddtrace
      if (tracer && tracer._log) {
        tracer._log.warn('req.body is not available. PubSub push requests require body parsing middleware ' +
          '(e.g., express.json())')
      }
      return null
    }

    try {
      return isCloudEvent ? this.parseCloudEventData(body, req) : this.parsePubSubData(body)
    } catch (err) {
      const tracer = this.tracer || global._ddtrace
      if (tracer && tracer._log) {
        tracer._log.warn('Failed to parse PubSub message data from req.body:', err)
      }
      return null
    }
  }

  // Extract tracing context from message attributes or headers
  extractTracingContext (messageData, req) {
    // Try message attributes first (where producer injected the context)
    if (messageData?.attrs) {
      const context = this.tracer.extract('text_map', messageData.attrs)
      if (context) return context
    }

    // Fallback to headers
    const carrier = this.buildHeaderCarrier(req)
    return this.tracer.extract('text_map', carrier) || undefined
  }

  // Build carrier from headers (W3C and Datadog)
  buildHeaderCarrier (req) {
    const carrier = {}

    // W3C headers
    if (req.headers.traceparent) carrier.traceparent = req.headers.traceparent
    if (req.headers.tracestate) carrier.tracestate = req.headers.tracestate

    // CloudEvent headers (fallback)
    if (req.headers['ce-traceparent'] && !carrier.traceparent) carrier.traceparent = req.headers['ce-traceparent']
    if (req.headers['ce-tracestate'] && !carrier.tracestate) carrier.tracestate = req.headers['ce-tracestate']
    // Datadog headers
    for (const k of ['x-datadog-trace-id', 'x-datadog-parent-id', 'x-datadog-sampling-priority', 'x-datadog-tags']) {
      if (req.headers[k]) carrier[k] = req.headers[k]
    }

    return carrier
  }

  parseCloudEventData (body, req) {
    const message = body.message || body
    const attrs = { ...message?.attributes }
    const subscription = body.subscription || req.headers['ce-subscription'] || 'cloud-event-subscription'

    // Add CloudEvent headers to attributes
    if (!attrs.traceparent) {
      const ceTraceParent = req.headers['ce-traceparent'] || req.headers.traceparent
      if (ceTraceParent) attrs.traceparent = ceTraceParent
    }
    if (!attrs.tracestate) {
      const ceTraceState = req.headers['ce-tracestate'] || req.headers.tracestate
      if (ceTraceState) attrs.tracestate = ceTraceState
    }

    if (req.headers['ce-source']) attrs['ce-source'] = req.headers['ce-source']
    if (req.headers['ce-type']) attrs['ce-type'] = req.headers['ce-type']

    const { projectId, topicName } = this.extractProjectAndTopic(attrs, subscription)
    return { message, subscription, attrs, projectId, topicName }
  }

  parsePubSubData (body) {
    const message = body.message
    const subscription = body.subscription
    const attrs = message?.attributes || {}

    const { projectId, topicName } = this.extractProjectAndTopic(attrs, subscription)
    return { message, subscription, attrs, projectId, topicName }
  }

  extractProjectAndTopic (attrs, subscription) {
    let projectId = attrs['gcloud.project_id']
    let topicName = attrs['pubsub.topic']

    if (!projectId && subscription) {
      const match = subscription.match(/projects\/([^\\/]+)\/subscriptions/)
      if (match) projectId = match[1]
    }

    if (!topicName) {
      topicName = 'push-subscription-topic'
    }

    return { projectId, topicName }
  }

  // Create synthetic delivery span for GCP PubSub push subscriptions
  // This method creates spans with scheduling duration, delivery duration, and CloudEvent metadata
  createDeliverySpan (messageData, isCloudEvent) {
    const { attrs, topicName, projectId, subscription, message } = messageData
    const deliveryTraceId = attrs['x-dd-delivery-trace-id']
    const deliverySpanId = attrs['x-dd-delivery-span-id']
    const deliveryStartTime = attrs['x-dd-delivery-start-time']

    // Get message ID from message or CloudEvent headers
    const messageId = (message && message.messageId) || attrs['ce-id']

    // Compute pubsub scheduling duration (publish → HTTP receipt)
    const publishStartTimeRaw = attrs['x-dd-publish-start-time']
    let schedulingMs = null
    if (publishStartTimeRaw) {
      const t0 = Number.parseInt(publishStartTimeRaw, 10)
      if (Number.isFinite(t0) && t0 > 0) {
        schedulingMs = Date.now() - t0
      }
    }

    const spanTags = {
      component: 'google-cloud-pubsub',
      'span.kind': 'internal',
      'span.type': 'pubsub',
      'gcloud.project_id': projectId,
      'pubsub.topic': topicName,
      'pubsub.subscription': subscription,
      'pubsub.message_id': messageId,
      'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push',
      'pubsub.operation': 'delivery'
    }

    // Add scheduling duration if available
    if (schedulingMs !== null) {
      spanTags['pubsub.scheduling_duration_ms'] = schedulingMs
    }

    // Add CloudEvent tags if applicable
    if (isCloudEvent) {
      if (attrs['ce-source']) spanTags['cloudevents.source'] = attrs['ce-source']
      if (attrs['ce-type']) spanTags['cloudevents.type'] = attrs['ce-type']
      if (attrs['ce-id']) spanTags['cloudevents.id'] = attrs['ce-id']
      if (attrs['ce-specversion']) spanTags['cloudevents.specversion'] = attrs['ce-specversion']
      if (attrs['ce-time']) spanTags['cloudevents.time'] = attrs['ce-time']
      spanTags['eventarc.trigger'] = 'pubsub'
    }

    const spanOptions = {
      resource: `${topicName} → ${subscription}`,
      type: 'pubsub',
      tags: spanTags
    }

    // Use publish start time for span timing if available
    if (publishStartTimeRaw) {
      const publishStartTime = Number.parseInt(publishStartTimeRaw, 10)
      if (Number.isFinite(publishStartTime) && publishStartTime > 0) {
        spanOptions.startTime = publishStartTime
      }
    } else if (deliveryTraceId && deliverySpanId && deliveryStartTime) {
      // Fallback to synthetic timing if available
      spanOptions.startTime = Number.parseInt(deliveryStartTime, 10)
    }

    const span = this.tracer.startSpan('pubsub.delivery', spanOptions)

    // Set synthetic context if available
    if (deliveryTraceId && deliverySpanId) {
      const context = span.context()
      context._traceId = deliveryTraceId
      context._spanId = deliverySpanId
    }

    // Calculate delivery duration and finish span
    const deliveryEnd = Date.now()
    if (publishStartTimeRaw) {
      const publishStartTime = Number.parseInt(publishStartTimeRaw, 10)
      if (Number.isFinite(publishStartTime) && publishStartTime > 0) {
        const deliveryDuration = deliveryEnd - publishStartTime
        span.setTag('pubsub.delivery.duration_ms', deliveryDuration)
      }
    }
    span.finish(deliveryEnd)

    return span
  }
}

module.exports = GoogleCloudPubsubTransitHandlerPlugin
