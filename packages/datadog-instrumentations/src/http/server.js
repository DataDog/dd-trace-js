'use strict'

const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')
const startWriteHeadCh = channel('apm:http:server:response:writeHead:start')
const finishSetHeaderCh = channel('datadog:http:server:response:set-header:finish')
const startSetHeaderCh = channel('datadog:http:server:response:set-header:start')

const requestFinishedSet = new WeakSet()

const httpNames = ['http', 'node:http']
const httpsNames = ['https', 'node:https']

function handlePubSubOrCloudEvent (req, res, emit, server, originalArgs) {
  const isCloudEvent = req.headers['content-type']?.includes('application/cloudevents+json') ||
    req.headers['ce-specversion']
  const eventType = isCloudEvent ? 'Cloud Event' : 'PubSub push'

  // Get tracer from global reference (avoids circular dependencies)
  const tracer = global._ddtrace
  if (!tracer) {
    return emit.apply(server, originalArgs)
  }

  // Collect raw body for PubSub message parsing with error handling
  const chunks = []
  const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB limit for large Pub/Sub payloads
  let bodySize = 0

  const cleanup = () => {
    req.removeAllListeners('data')
    req.removeAllListeners('end')
    req.removeAllListeners('error')
  }

  // eslint-disable-next-line n/handle-callback-err
  const handleError = (error) => {
    cleanup()
    emit.apply(server, originalArgs)
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
      // Efficiently combine chunks for large payloads
      const body = Buffer.concat(chunks).toString('utf8')
      const json = JSON.parse(body)
      req.body = json // Set parsed body for framework use
      req._pubsubBodyParsed = true // Flag to skip body-parser

      // Extract message and attributes based on format
      let message, subscription, attrs

      if (isCloudEvent) {
        if (req.headers['ce-specversion']) {
          // Binary Content Mode - message in body, trace context in headers
          message = json
          attrs = { ...message?.attributes }
          subscription = req.headers['ce-subscription'] || 'cloud-event-subscription'

          // Merge trace context from headers
          const ceTraceParent = req.headers['ce-traceparent'] || req.headers.traceparent
          const ceTraceState = req.headers['ce-tracestate'] || req.headers.tracestate
          if (ceTraceParent) attrs.traceparent = ceTraceParent
          if (ceTraceState) attrs.tracestate = ceTraceState
        } else {
          // Structured Content Mode - message in data field
          message = json.data?.message || json
          subscription = json.data?.subscription || json.subscription || 'cloud-event-subscription'
          attrs = { ...message?.attributes }

          // Add Cloud Events context
          if (json.source) attrs['ce-source'] = json.source
          if (json.type) attrs['ce-type'] = json.type
        }
      } else {
        // Traditional PubSub push format
        message = json.message
        subscription = json.subscription
        attrs = message?.attributes || {}
      }

      if (!attrs || typeof attrs !== 'object' || Object.keys(attrs).length === 0) {
        cleanup()
        return emit.apply(server, originalArgs)
      }

      // Extract trace context from PubSub message attributes (optimized)
      const carrier = {}
      const traceHeaders = ['traceparent', 'tracestate',
        'x-datadog-trace-id', 'x-datadog-parent-id',
        'x-datadog-sampling-priority', 'x-datadog-tags']
      for (const header of traceHeaders) {
        if (attrs[header]) {
          carrier[header] = attrs[header]
        }
      }

      // Extract parent span context (key for distributed tracing!)
      const parent = tracer.extract('text_map', carrier)

      // Extract project ID and topic from subscription path if not in attributes
      let projectId = attrs['gcloud.project_id']
      let topicName = attrs['pubsub.topic']

      if (!projectId && subscription) {
        // Extract from subscription path: projects/PROJECT_ID/subscriptions/SUBSCRIPTION_NAME
        const match = subscription.match(/projects\/([^\\/]+)\/subscriptions/)
        if (match) projectId = match[1]
      }

      if (!topicName) {
        topicName = 'push-subscription-topic'
      }

      // Create PubSub consumer span with error handling
      let span
      try {
        span = tracer.startSpan('google-cloud-pubsub.receive', {
          childOf: parent,
          tags: {
            component: 'google-cloud-pubsub',
            'span.kind': 'consumer',
            'span.type': 'worker',
            'gcloud.project_id': projectId || 'unknown',
            'pubsub.topic': topicName || 'unknown',
            'pubsub.subscription': subscription,
            'pubsub.message_id': message?.messageId,
            'pubsub.delivery_method': isCloudEvent ? 'cloud-event' : 'push',
            'pubsub.ack': 1 // Push subscriptions auto-ack
          }
        })
      } catch {
        cleanup()
        return emit.apply(server, originalArgs)
      }

      // Attach span to request for application code
      req._datadog = { span }
      req._eventType = eventType

      // Activate span scope and continue with error handling
      const scope = tracer.scope()
      const finishSpan = () => {
        try {
          if (span && !span.finished) {
            span.finish()
          }
        } catch {}
        cleanup()
      }
      try {
        scope.activate(span, () => {
          // Finish span when response completes (with error handling)
          res.on('finish', finishSpan)
          res.on('close', finishSpan)
          res.on('error', (resError) => {
            if (span && !span.finished) {
              span.setTag('error', true)
              span.setTag('error.message', resError.message)
            }
            finishSpan()
          })

          // Continue with normal request processing
          emit.apply(server, originalArgs)
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
      emit.apply(server, originalArgs)
    }
  })
}

addHook({ name: httpNames }, http => {
  shimmer.wrap(http.ServerResponse.prototype, 'emit', wrapResponseEmit)
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  shimmer.wrap(http.ServerResponse.prototype, 'writeHead', wrapWriteHead)
  shimmer.wrap(http.ServerResponse.prototype, 'write', wrapWrite)
  shimmer.wrap(http.ServerResponse.prototype, 'end', wrapEnd)
  shimmer.wrap(http.ServerResponse.prototype, 'setHeader', wrapSetHeader)
  shimmer.wrap(http.ServerResponse.prototype, 'removeHeader', wrapAppendOrRemoveHeader)
  // Added in node v16.17.0
  if (http.ServerResponse.prototype.appendHeader) {
    shimmer.wrap(http.ServerResponse.prototype, 'appendHeader', wrapAppendOrRemoveHeader)
  }
  return http
})

addHook({ name: httpsNames }, http => {
  // http.ServerResponse not present on https
  shimmer.wrap(http.Server.prototype, 'emit', wrapEmit)
  return http
})

function wrapResponseEmit (emit) {
  return function (eventName, event) {
    if (!finishServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (['finish', 'close'].includes(eventName) && !requestFinishedSet.has(this)) {
      finishServerCh.publish({ req: this.req })
      requestFinishedSet.add(this)
    }

    return emit.apply(this, arguments)
  }
}

function wrapEmit (emit) {
  return function (eventName, req, res) {
    if (!startServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (eventName === 'request') {
      // Handle PubSub push AND Cloud Events at HTTP server level - works with ANY framework
      const isPubSubOrCloudEvent = req.method === 'POST' && (
        // Traditional PubSub push
        (req.headers['content-type']?.includes('application/json') &&
          req.headers['user-agent']?.includes('APIs-Google')) ||
        // Cloud Events
        req.headers['content-type']?.includes('application/cloudevents+json') ||
        req.headers['ce-specversion'] // Binary Content Mode
      )

      if (isPubSubOrCloudEvent) {
        return handlePubSubOrCloudEvent(req, res, emit, this, arguments)
      }

      res.req = req

      const abortController = new AbortController()

      startServerCh.publish({ req, res, abortController })

      try {
        if (abortController.signal.aborted) {
          // TODO: should this always return true ?
          return this.listenerCount(eventName) > 0
        }

        return emit.apply(this, arguments)
      } catch (err) {
        errorServerCh.publish(err)

        throw err
      } finally {
        exitServerCh.publish({ req })
      }
    }
    return emit.apply(this, arguments)
  }
}

function wrapWriteHead (writeHead) {
  return function wrappedWriteHead (statusCode, reason, obj) {
    if (!startWriteHeadCh.hasSubscribers) {
      return writeHead.apply(this, arguments)
    }

    const abortController = new AbortController()

    if (typeof reason !== 'string') {
      obj ??= reason
    }

    // support writeHead(200, ['key1', 'val1', 'key2', 'val2'])
    if (Array.isArray(obj)) {
      const headers = {}

      for (let i = 0; i < obj.length; i += 2) {
        headers[obj[i]] = obj[i + 1]
      }

      obj = headers
    }

    // this doesn't support explicit duplicate headers, but it's an edge case
    const responseHeaders = Object.assign(this.getHeaders(), obj)

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode,
      responseHeaders
    })

    if (abortController.signal.aborted) {
      return this
    }

    return writeHead.apply(this, arguments)
  }
}

function wrapWrite (write) {
  return function wrappedWrite () {
    if (!startWriteHeadCh.hasSubscribers) {
      return write.apply(this, arguments)
    }

    const abortController = new AbortController()

    const responseHeaders = this.getHeaders()

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders
    })

    if (abortController.signal.aborted) {
      return true
    }

    return write.apply(this, arguments)
  }
}

function wrapSetHeader (setHeader) {
  return function wrappedSetHeader (name, value) {
    if (!startSetHeaderCh.hasSubscribers && !finishSetHeaderCh.hasSubscribers) {
      return setHeader.apply(this, arguments)
    }

    if (startSetHeaderCh.hasSubscribers) {
      const abortController = new AbortController()
      startSetHeaderCh.publish({ res: this, abortController })

      if (abortController.signal.aborted) {
        return
      }
    }

    const setHeaderResult = setHeader.apply(this, arguments)

    if (finishSetHeaderCh.hasSubscribers) {
      finishSetHeaderCh.publish({ name, value, res: this })
    }

    return setHeaderResult
  }
}

function wrapAppendOrRemoveHeader (originalMethod) {
  return function wrappedAppendOrRemoveHeader () {
    if (!startSetHeaderCh.hasSubscribers) {
      return originalMethod.apply(this, arguments)
    }

    const abortController = new AbortController()
    startSetHeaderCh.publish({ res: this, abortController })

    if (abortController.signal.aborted) {
      return this
    }

    return originalMethod.apply(this, arguments)
  }
}

function wrapEnd (end) {
  return function wrappedEnd () {
    if (!startWriteHeadCh.hasSubscribers) {
      return end.apply(this, arguments)
    }

    const abortController = new AbortController()

    const responseHeaders = this.getHeaders()

    startWriteHeadCh.publish({
      req: this.req,
      res: this,
      abortController,
      statusCode: this.statusCode,
      responseHeaders
    })

    if (abortController.signal.aborted) {
      return this
    }

    return end.apply(this, arguments)
  }
}
