'use strict'

// Datadog plugin for Google Cloud PubSub HTTP handler
// This subscribes to request intercept channel and handles PubSub requests

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const web = require('../../dd-trace/src/plugins/util/web')
const { getSharedChannel } = require('../../datadog-instrumentations/src/shared-channels')

class GoogleCloudPubsubHttpHandlerPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-pubsub-http-handler' }

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
    // Collect request body
    const chunks = []
    let bodySize = 0
    const MAX_BODY_SIZE = 10 * 1024 * 1024

    const cleanup = () => {
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.removeAllListeners('error')
    }

    req.on('error', () => {
      cleanup()
      emit.apply(server, originalArgs)
    })

    req.on('data', chunk => {
      bodySize += chunk.length
      if (bodySize > MAX_BODY_SIZE) {
        cleanup()
        emit.apply(server, originalArgs)
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
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

        // Extract trace context and create span
        const parent = this.extractTraceContext(this.tracer, attrs)
        const { projectId, topicName } = this.extractProjectAndTopic(attrs, subscription)
        const span = this.createSpan(
          this.tracer, parent, topicName, projectId, subscription, message, attrs, req, isCloudEvent
        )

        // SIMPLE APPROACH: Add parsed body directly to req
        // This prevents body-parser from trying to read the stream again
        req.body = json
        req._datadog = { span }

        // Set up span finishing
        const finishSpan = () => {
          if (span && !span.finished) {
            span.finish()
          }
        }
        res.on('finish', finishSpan)
        res.on('close', finishSpan)
        res.on('error', (resError) => {
          if (span && !span.finished) {
            span.setTag('error', true)
            span.setTag('error.message', resError.message)
          }
          finishSpan()
        })

        // Create span hierarchy: PubSub -> HTTP -> Express
        const scope = this.tracer.scope()
        scope.activate(span, () => {
          // Create HTTP span as child of PubSub span
          const httpSpan = this.tracer.startSpan('http.request', {
            childOf: span,
            tags: {
              'http.method': req.method,
              'http.url': `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${req.url}`,
              'span.kind': 'server',
              component: 'http'
            }
          })

          // Set up HTTP span finishing
          const finishHttpSpan = () => {
            if (httpSpan && !httpSpan.finished) {
              httpSpan.setTag('http.status_code', res.statusCode)
              if (res.statusCode >= 400) {
                httpSpan.setTag('error', true)
              }
              httpSpan.finish()
            }
          }
          res.on('finish', finishHttpSpan)
          res.on('close', finishHttpSpan)

          // Set up web context so HTTP plugin doesn't create duplicate spans
          const context = web.patch(req)
          context.span = httpSpan
          context.tracer = this.tracer
          context.res = res

          // Activate HTTP span so Express inherits from it
          scope.activate(httpSpan, () => {
            cleanup()
            emit.call(server, 'request', req, res)
          })
        })
      } catch {
        cleanup()
        emit.apply(server, originalArgs)
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

  // Datadog-specific trace context extraction
  extractTraceContext (tracer, attrs) {
    const carrier = {}
    const traceHeaders = ['traceparent', 'tracestate',
      'x-datadog-trace-id', 'x-datadog-parent-id',
      'x-datadog-sampling-priority', 'x-datadog-tags']

    for (const header of traceHeaders) {
      if (attrs[header]) {
        carrier[header] = attrs[header]
      }
    }

    try {
      const result = tracer.extract('text_map', carrier) || null
      return result
    } catch {
      return null
    }
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

  createSpan (tracer, parent, topicName, projectId, subscription, message, attrs, req, isCloudEvent) {
    const spanTags = {
      component: 'google-cloud-pubsub',
      'span.kind': 'consumer',
      'gcloud.project_id': projectId,
      'pubsub.topic': topicName,
      'pubsub.subscription': subscription,
      'pubsub.message_id': message?.messageId,
      'pubsub.delivery_method': isCloudEvent ? 'eventarc' : 'push'
    }

    if (isCloudEvent) {
      if (attrs['ce-source']) spanTags['cloudevents.source'] = attrs['ce-source']
      if (attrs['ce-type']) spanTags['cloudevents.type'] = attrs['ce-type']
      if (req.headers['ce-id']) spanTags['cloudevents.id'] = req.headers['ce-id']
      if (req.headers['ce-specversion']) spanTags['cloudevents.specversion'] = req.headers['ce-specversion']
      if (req.headers['ce-time']) spanTags['cloudevents.time'] = req.headers['ce-time']
      spanTags['eventarc.trigger'] = 'pubsub'
    }

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

    if (!span.context().parentId && parent && parent._spanId) {
      span.context()._parentId = parent._spanId
      span.context()._traceId = parent._traceId
    }

    return span
  }
}

module.exports = GoogleCloudPubsubHttpHandlerPlugin
