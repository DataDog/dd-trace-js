'use strict'

// Detection functions
function isPubSubRequest (req) {
  return req.method === 'POST' &&
    !!req.headers['content-type']?.includes('application/json') &&
    !!req.headers['user-agent']?.includes('APIs-Google')
}

function isCloudEventRequest (req) {
  return req.method === 'POST' && !!req.headers['ce-specversion']
}

// Message parsing functions
function parseCloudEventMessage (json, req) {
  // Eventarc only uses Binary Content Mode with ce-specversion header
  const message = json.message || json
  const attrs = { ...message?.attributes }
  const subscription = json.subscription || req.headers['ce-subscription'] || 'cloud-event-subscription'

  // For Eventarc: prioritize message attributes (original trace) over transport headers
  if (!attrs.traceparent) {
    const ceTraceParent = req.headers['ce-traceparent'] || req.headers.traceparent
    if (ceTraceParent) attrs.traceparent = ceTraceParent
  }
  if (!attrs.tracestate) {
    const ceTraceState = req.headers['ce-tracestate'] || req.headers.tracestate
    if (ceTraceState) attrs.tracestate = ceTraceState
  }

  // Add Cloud Event context from headers to attributes for span tags
  if (req.headers['ce-source']) attrs['ce-source'] = req.headers['ce-source']
  if (req.headers['ce-type']) attrs['ce-type'] = req.headers['ce-type']
  return { message, subscription, attrs }
}

function parsePubSubMessage (json) {
  // Traditional PubSub push format
  const message = json.message
  const subscription = json.subscription
  const attrs = message?.attributes || {}
  return { message, subscription, attrs }
}

// Utility functions
function extractTraceContext (tracer, attrs) {
  const carrier = {}
  const traceHeaders = ['traceparent', 'tracestate',
    'x-datadog-trace-id', 'x-datadog-parent-id',
    'x-datadog-sampling-priority', 'x-datadog-tags']

  for (const header of traceHeaders) {
    if (attrs[header]) {
      carrier[header] = attrs[header]
    }
  }

  return tracer.extract('text_map', carrier) || null
}

function extractProjectAndTopic (attrs, subscription) {
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

function createSpan (tracer, parent, topicName, projectId, subscription, message, attrs, req, isCloudEvent) {
  const spanTags = {
    component: 'google-cloud-pubsub',
    'span.kind': 'consumer',
    'gcloud.project_id': projectId,
    'pubsub.topic': topicName,
    'pubsub.subscription': subscription,
    'pubsub.message_id': message?.messageId,
    'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push'
  }

  // Add Cloud Event specific tags
  if (isCloudEvent) {
    if (attrs['ce-source']) spanTags['cloudevents.source'] = attrs['ce-source']
    if (attrs['ce-type']) spanTags['cloudevents.type'] = attrs['ce-type']
    if (req.headers['ce-id']) spanTags['cloudevents.id'] = req.headers['ce-id']
    if (req.headers['ce-specversion']) spanTags['cloudevents.specversion'] = req.headers['ce-specversion']
    if (req.headers['ce-time']) spanTags['cloudevents.time'] = req.headers['ce-time']
    spanTags['eventarc.trigger'] = 'pubsub'
  }
  // Try different approaches to set the parent using a ternary expression
  const spanOptions = {
    ...(parent && parent._spanId ? { childOf: parent } : {}),
    resource: topicName,
    type: 'worker',
    tags: spanTags,
    metrics: {
      'pubsub.ack': 1
    }
  }
  const span = tracer.startSpan('pubsub.receive', spanOptions)

  // CRITICAL FIX: If parent ID is still undefined, manually set it
  if (!span.context().parentId && parent && parent._spanId) {
    // Force the parent relationship
    span.context()._parentId = parent._spanId
    span.context()._traceId = parent._traceId
  }

  return span
}

// Main event processing function - creates spans but doesn't emit (wrapper handles that)
function processEventRequest (req, res, emit, server, originalArgs, isCloudEvent) {
  const eventType = isCloudEvent ? 'Cloud Event' : 'PubSub push'

  // Get tracer from global reference
  const tracer = global._ddtrace
  if (!tracer) {
    return // Let wrapper handle emit
  }

  // Collect raw body for message parsing with error handling
  const chunks = []
  const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB limit
  let bodySize = 0

  const cleanup = () => {
    req.removeAllListeners('data')
    req.removeAllListeners('end')
    req.removeAllListeners('error')
  }

  const handleError = () => {
    cleanup()
    // Let wrapper handle emit
  }

  req.on('error', handleError)

  req.on('data', chunk => {
    bodySize += chunk.length
    if (bodySize > MAX_BODY_SIZE) {
      handleError(new Error(`Request body too large: ${bodySize} bytes (limit: ${MAX_BODY_SIZE})`))
      return
    }
    chunks.push(chunk)
  })

  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8')
      const json = JSON.parse(body)
      req.body = json

      // Parse message based on event type
      const parsedEvent = isCloudEvent
        ? parseCloudEventMessage(json, req)
        : parsePubSubMessage(json)

      if (!parsedEvent) {
        cleanup()
        return // Let wrapper handle emit
      }

      const { message, subscription, attrs } = parsedEvent

      if (!attrs || typeof attrs !== 'object' || Object.keys(attrs).length === 0) {
        cleanup()
        return // Let wrapper handle emit
      }
      // Extract trace context and project/topic info
      const parent = extractTraceContext(tracer, attrs)
      const { projectId, topicName } = extractProjectAndTopic(attrs, subscription)
      // Create span
      let span
      try {
        span = createSpan(tracer, parent, topicName, projectId, subscription, message, attrs, req, isCloudEvent)
      } catch {
        cleanup()
        return // Let wrapper handle emit
      }

      // Attach span to request for application code
      req._datadog = { span }
      req._eventType = eventType
      req._pubsubSpanCreated = true

      // Set PubSub span as parent for HTTP and Express spans
      req._parentSpan = span

      // CRITICAL: Activate span scope and emit like the old working code
      const scope = tracer.scope()
      const finishSpan = () => {
        try {
          if (span && !span.finished) {
            span.finish()
          }
        } catch {}
        cleanup()
      }

      // Set up span finishing when response completes
      res.on('finish', finishSpan)
      res.on('close', finishSpan)
      res.on('error', (resError) => {
        if (span && !span.finished) {
          span.setTag('error', true)
          span.setTag('error.message', resError.message)
        }
        finishSpan()
      })

      try {
        scope.activate(span, () => {
          // CRITICAL: Inject PubSub span context into request headers
          // This ensures HTTP plugin creates HTTP span as child of PubSub span
          const spanContext = span.context()
          tracer.inject(spanContext, 'http_headers', req.headers)

          // CRITICAL: Manually create HTTP span as child of PubSub span
          // Since plugin subscriptions run outside our activated context, we create it directly
          const httpSpan = tracer.startSpan('http.request', {
            childOf: span,
            tags: {
              'http.method': req.method,
              'http.url': `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${req.url}`,
              'span.kind': 'server',
              component: 'http'
            }
          })

          // CRITICAL: Set up web context to use our HTTP span so HTTP plugin doesn't create a new one
          const web = require('../../dd-trace/src/plugins/util/web')
          const context = web.patch(req)
          context.span = httpSpan
          context.tracer = tracer
          context.res = res

          // Set up HTTP span finishing
          const finishHttpSpan = () => {
            if (httpSpan && !httpSpan.finished) {
              httpSpan.setTag('http.status_code', res.statusCode)
              httpSpan.finish()
            }
          }
          res.on('finish', finishHttpSpan)
          res.on('close', finishHttpSpan)

          // CRITICAL: Activate HTTP span and call emit so Express inherits from HTTP span
          scope.activate(httpSpan, () => {
            emit.apply(server, originalArgs)
          })
        })
      } catch {
        if (span && !span.finished) {
          span.finish()
        }
        cleanup()
        emit.apply(server, originalArgs)
      }
    } catch {
      cleanup()
      // Let wrapper handle emit
    }
  })
}

// Export functions for use by server.js
module.exports = {
  isPubSubRequest,
  isCloudEventRequest,
  processEventRequest
}
