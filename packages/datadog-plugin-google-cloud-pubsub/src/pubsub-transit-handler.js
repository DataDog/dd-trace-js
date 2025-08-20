'use strict'

// Datadog plugin for Google Cloud PubSub Transit handler
// Subscribes to the HTTP server request intercept channel and handles Pub/Sub push/CloudEvent requests.

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const web = require('../../dd-trace/src/plugins/util/web')
const { getSharedChannel } = require('../../datadog-instrumentations/src/shared-channels')

// 10MB max body size for Pub/Sub push requests
const MAX_BODY_SIZE = 10 * 1024 * 1024

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
    // Quick pre-check based on Content-Length header
    const contentLengthHeader = req.headers['content-length']
    if (contentLengthHeader && Number.parseInt(contentLengthHeader, 10) > MAX_BODY_SIZE) {
      return emit.apply(server, originalArgs)
    }

    // Collect request body
    const chunks = []
    let bodySize = 0

    const cleanup = () => {
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.removeAllListeners('error')
    }

    req.once('error', (err) => {
      cleanup()
      // Pass through to the original server handler so it can respond normally
      if (!res.headersSent) emit.apply(server, originalArgs)
      if (err) { /* acknowledge error */ }
    })

    req.on('data', chunk => {
      bodySize += chunk.length
      if (bodySize > MAX_BODY_SIZE) {
        cleanup()
        if (!res.headersSent) return emit.apply(server, originalArgs)
        return
      }
      chunks.push(chunk)
    })

    req.once('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        const json = JSON.parse(body)

        // Parse message based on event type
        const parsedEvent = isCloudEvent
          ? this.parseCloudEventMessage(json, req)
          : this.parsePubSubMessage(json)

        if (!parsedEvent) {
          cleanup()
          return emit.apply(server, originalArgs)
        }

        const { message, subscription, attrs } = parsedEvent

        if (!attrs || typeof attrs !== 'object' || Object.keys(attrs).length === 0) {
          cleanup()
          return emit.apply(server, originalArgs)
        }

        // Extract project/topic from attributes
        const { projectId, topicName } = this.extractProjectAndTopic(attrs, subscription)

        // Extract producer context (Datadog/W3C) straight from message attributes
        const producerParent = this.tracer.extract('text_map', attrs) || null
        const effectiveParent = producerParent || undefined

        // ToDo: create pubsub.delivery; create HTTP span directly as child of producer

        // Add parsed body for downstream middleware that expects it
        req.body = json
        // Create enhanced HTTP span as child of producer
        const httpSpan = this.tracer.startSpan('http.request', {
          childOf: effectiveParent,
          tags: {
            'http.method': req.method,
            'http.url': `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${req.url}`,
            'span.kind': 'server',
            component: 'http',
            // Enhanced with PubSub metadata for user visibility
            'pubsub.topic': topicName,
            'pubsub.subscription': subscription,
            'pubsub.message_id': message?.messageId,
            'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push',
            'gcloud.project_id': projectId
          }
        })
        // Keep HTTP/Express under the application's base service
        try { httpSpan.setTag('service.name', this.tracer._service) } catch {}

        // Set up span finishing for http span (delivery span already finished)
        const finishHttpSpan = () => {
          if (httpSpan && !httpSpan.finished) {
            httpSpan.setTag('http.status_code', res.statusCode)
            if (res.statusCode >= 400) {
              httpSpan.setTag('error', true)
            }
            httpSpan.finish()
          }
        }

        res.once('finish', () => {
          finishHttpSpan()
        })
        res.once('close', () => {
          finishHttpSpan()
        })
        res.once('error', (resError) => {
          if (httpSpan && !httpSpan.finished) {
            httpSpan.setTag('error', true)
            httpSpan.setTag('error.message', resError.message)
            httpSpan.finish()
          }
        })

        // Set up web context so HTTP plugin doesn't create duplicate spans
        const context = web.patch(req)
        context.span = httpSpan
        context.tracer = this.tracer
        context.res = res

        // Activate HTTP -> Express
        const scope = this.tracer.scope()
        scope.activate(httpSpan, () => {
          cleanup()
          emit.call(server, 'request', req, res)
        })
      } catch {
        cleanup()
        // Invalid JSON: let the original server handle the request (expected 200 in tests)
        if (!res.headersSent) return emit.apply(server, originalArgs)
      }
    })
  }

  // Message parsing functions
  parseCloudEventMessage (json, req) {
    const message = json.message || json
    const attrs = { ...message?.attributes }
    const subscription = json.subscription || req.headers['ce-subscription'] || 'cloud-event-subscription'

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
    return { message, subscription, attrs }
  }

  parsePubSubMessage (json) {
    const message = json.message
    const subscription = json.subscription
    const attrs = message?.attributes || {}
    return { message, subscription, attrs }
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

  createAndFinishDeliverySpan (tracer, attrs, topicName, projectId, subscription, isCloudEvent) {
    // Extract synthetic delivery span context from message attributes
    const deliveryTraceId = attrs['x-dd-delivery-trace-id']
    const deliverySpanId = attrs['x-dd-delivery-span-id']
    const deliveryStartTime = attrs['x-dd-delivery-start-time']

    if (!deliveryTraceId || !deliverySpanId || !deliveryStartTime) {
      // Fallback: create regular span if no synthetic context available
      return this.createFallbackDeliverySpan(tracer, topicName, projectId, subscription, isCloudEvent)
    }

    // Create synthetic delivery span with proper timing
    const spanTags = {
      component: 'google-cloud-pubsub',
      'span.kind': 'internal',
      'span.type': 'pubsub',
      'gcloud.project_id': projectId,
      'pubsub.topic': topicName,
      'pubsub.subscription': subscription,
      'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push',
      'pubsub.operation': 'delivery'
    }

    if (isCloudEvent) {
      if (attrs['ce-source']) spanTags['cloudevents.source'] = attrs['ce-source']
      if (attrs['ce-type']) spanTags['cloudevents.type'] = attrs['ce-type']
      spanTags['eventarc.trigger'] = 'pubsub'
    }

    const startTime = Number.parseInt(deliveryStartTime, 10)
    const endTime = Date.now()

    // Create the span with custom context
    const spanOptions = {
      resource: `${topicName} → ${subscription}`,
      type: 'pubsub',
      tags: spanTags,
      startTime
    }

    const span = tracer.startSpan('pubsub.delivery', spanOptions)

    // Set the span context to match the synthetic context created on producer side
    const context = span.context()
    context._traceId = deliveryTraceId
    context._spanId = deliverySpanId

    // Immediately finish the span since it represents past infrastructure work
    span.finish(endTime)

    return span
  }

  createFallbackDeliverySpan (tracer, topicName, projectId, subscription, isCloudEvent) {
    // Fallback for when synthetic context is not available
    const spanTags = {
      component: 'google-cloud-pubsub',
      'span.kind': 'internal',
      'span.type': 'pubsub',
      'gcloud.project_id': projectId,
      'pubsub.topic': topicName,
      'pubsub.subscription': subscription,
      'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push',
      'pubsub.operation': 'delivery'
    }

    const spanOptions = {
      resource: `${topicName} → ${subscription}`,
      type: 'pubsub',
      tags: spanTags
    }

    const span = tracer.startSpan('pubsub.delivery', spanOptions)

    // Immediately finish since we don't know the actual delivery duration
    span.finish()

    return span
  }
}

module.exports = GoogleCloudPubsubTransitHandlerPlugin
