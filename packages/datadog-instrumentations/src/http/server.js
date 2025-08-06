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

function parseCloudEventMessage (json, req) {
  // Eventarc only uses Binary Content Mode with ce-specversion header
  // Payload structure: {"message": {...}, "subscription": "..."}
  const message = json.message || json
  const attrs = { ...message?.attributes }
  const subscription = json.subscription || req.headers['ce-subscription'] || 'cloud-event-subscription'

  // For Eventarc: prioritize message attributes (original trace) over transport headers
  // Only use CE headers if message attributes don't have trace context
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

function createCloudEventSpan (tracer, parent, topicName, projectId, subscription, message, attrs, req) {
  const spanTags = {
    component: 'google-cloud-pubsub',
    'span.kind': 'consumer',
    'gcloud.project_id': projectId || 'unknown',
    'pubsub.topic': topicName || 'unknown',
    'pubsub.subscription': subscription,
    'pubsub.message_id': message?.messageId,
    'pubsub.delivery_method': 'eventarc',
    'eventarc.trigger': 'pubsub',
  }

  // Add Cloud Event specific tags
  if (attrs['ce-source']) spanTags['eventarc.source'] = attrs['ce-source']
  if (attrs['ce-type']) spanTags['eventarc.type'] = attrs['ce-type']
  if (req.headers['ce-id']) spanTags['eventarc.id'] = req.headers['ce-id']
  if (req.headers['ce-specversion']) spanTags['eventarc.specversion'] = req.headers['ce-specversion']
  if (req.headers['ce-time']) spanTags['eventarc.time'] = req.headers['ce-time']

  return tracer.startSpan('google-cloud-pubsub.receive', {
    childOf: parent,
    resource: topicName,
    type: 'worker',
    tags: spanTags,
    metrics: {
      'pubsub.ack': 1
    }
  })
}

function createPubSubSpan (tracer, parent, topicName, projectId, subscription, message, attrs) {
  const spanTags = {
    component: 'google-cloud-pubsub',
    'span.kind': 'consumer',
    'gcloud.project_id': projectId || 'unknown',
    'pubsub.topic': topicName || 'unknown',
    'pubsub.subscription': subscription,
    'pubsub.message_id': message?.messageId,
    'pubsub.delivery_method': 'push'
  }
  return tracer.startSpan('google-cloud-pubsub.receive', {
    childOf: parent,
    resource: topicName,
    type: 'worker',
    tags: spanTags,
    metrics: {
      'pubsub.ack': 1
    }
  })
}

function handleCloudEvent (req, res, emit, server, originalArgs) {
  // Get tracer from global reference (avoids circular dependencies)
  const tracer = global._ddtrace
  if (!tracer) {
    return emit.apply(server, originalArgs)
  }

  return processEventRequest(req, res, emit, server, originalArgs, tracer, true)
}

function handlePubSubPush (req, res, emit, server, originalArgs) {
  // Get tracer from global reference (avoids circular dependencies)
  const tracer = global._ddtrace
  if (!tracer) {
    return emit.apply(server, originalArgs)
  }

  return processEventRequest(req, res, emit, server, originalArgs, tracer, false)
}

function processEventRequest (req, res, emit, server, originalArgs, tracer, isCloudEvent) {
  const eventType = isCloudEvent ? 'Cloud Event' : 'PubSub push'

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

      // Parse message based on event type
      const parsedEvent = isCloudEvent
        ? parseCloudEventMessage(json, req)
        : parsePubSubMessage(json)

      if (!parsedEvent) {
        cleanup()
        return emit.apply(server, originalArgs)
      }

      const { message, subscription, attrs } = parsedEvent

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

      // Create span based on event type
      let span
      try {
        span = isCloudEvent
          ? createCloudEventSpan(tracer, parent, topicName, projectId, subscription, message, attrs, req)
          : createPubSubSpan(tracer, parent, topicName, projectId, subscription, message, attrs)
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
      if (req.method === 'POST') {
        // Cloud Events detection (Eventarc uses Binary Content Mode with ce-specversion header)
        const isCloudEvent = req.headers['ce-specversion']

        // Traditional PubSub push detection
        const isPubSubPush = req.headers['content-type']?.includes('application/json') &&
          req.headers['user-agent']?.includes('APIs-Google')

        if (isCloudEvent) {
          return handleCloudEvent(req, res, emit, this, arguments)
        } else if (isPubSubPush) {
          return handlePubSubPush(req, res, emit, this, arguments)
        }
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
