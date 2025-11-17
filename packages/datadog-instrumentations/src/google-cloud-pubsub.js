'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const requestStartCh = channel('apm:google-cloud-pubsub:request:start')
const requestFinishCh = channel('apm:google-cloud-pubsub:request:finish')
const requestErrorCh = channel('apm:google-cloud-pubsub:request:error')

const receiveStartCh = channel('apm:google-cloud-pubsub:receive:start')
const receiveFinishCh = channel('apm:google-cloud-pubsub:receive:finish')
const receiveErrorCh = channel('apm:google-cloud-pubsub:receive:error')

const publisherMethods = [
  'createTopic',
  'updateTopic',
  'publish',
  'getTopic',
  'listTopics',
  'listTopicSubscriptions',
  'listTopicSnapshots',
  'deleteTopic',
  'detachSubscription'
]

const schemaServiceMethods = [
  'createSchema',
  'getSchema',
  'listSchemas',
  'listSchemaRevisions',
  'commitSchema',
  'rollbackSchema',
  'deleteSchemaRevision',
  'deleteSchema',
  'validateSchema',
  'validateMessage'
]

const subscriberMethods = [
  'createSubscription',
  'getSubscription',
  'updateSubscription',
  'listSubscriptions',
  'deleteSubscription',
  'modifyAckDeadline',
  'acknowledge',
  'pull',
  'streamingPull',
  'modifyPushConfig',
  'getSnapshot',
  'listSnapshots',
  'createSnapshot',
  'updateSnapshot',
  'deleteSnapshot',
  'seek'
]

function wrapMethod (method) {
  const api = method.name

  return function (request) {
    log.debug(`[DD DEBUG] wrapMethod called for API: ${api}, hasSubscribers: ${requestStartCh.hasSubscribers}`)
    if (!requestStartCh.hasSubscribers) return method.apply(this, arguments)

    log.debug(`[DD DEBUG] Creating span for ${api}`)
    const ctx = { request, api, projectId: this.auth._cachedProjectId }
    return requestStartCh.runStores(ctx, () => {
      const cb = arguments[arguments.length - 1]

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function (error) {
          if (error) {
            ctx.error = error
            requestErrorCh.publish(ctx)
          }
          return requestFinishCh.runStores(ctx, cb, this, ...arguments)
        })
        return method.apply(this, arguments)
      }

      return method.apply(this, arguments)
        .then(
          response => {
            requestFinishCh.publish(ctx)
            return response
          },
          error => {
            ctx.error = error
            requestErrorCh.publish(ctx)
            requestFinishCh.publish(ctx)
            throw error
          }
        )
    })
  }
}

function massWrap (obj, methods, wrapper) {
  methods.forEach(method => {
    if (typeof obj[method] === 'function') {
      shimmer.wrap(obj, method, wrapper)
    }
  })
}

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  const Subscription = obj.Subscription

  shimmer.wrap(Subscription.prototype, 'emit', emit => function (eventName, message) {
    if (eventName !== 'message' || !message) return emit.apply(this, arguments)

    const ctx = {}
    try {
      return emit.apply(this, arguments)
    } catch (err) {
      ctx.error = err
      receiveErrorCh.publish(ctx)
      throw err
    }
  })

  return obj
})

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/lease-manager.js' }, (obj) => {
  const LeaseManager = obj.LeaseManager
  const ctx = {}

  shimmer.wrap(LeaseManager.prototype, '_dispense', dispense => function (message) {
    if (receiveStartCh.hasSubscribers) {
      ctx.message = message
      return receiveStartCh.runStores(ctx, dispense, this, ...arguments)
    }
    return dispense.apply(this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'remove', remove => function (message) {
    return receiveFinishCh.runStores(ctx, remove, this, ...arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'clear', clear => function () {
    for (const message of this._messages) {
      ctx.message = message
      receiveFinishCh.publish(ctx)
    }
    return clear.apply(this, arguments)
  })

  return obj
})

// Inject trace context into Pub/Sub message attributes
function injectTraceContext (attributes, pubsub, topicName) {
  if (attributes['x-datadog-trace-id'] || attributes.traceparent) return

  try {
    const tracer = require('../../dd-trace')
    const activeSpan = tracer.scope().active()
    if (!activeSpan) return

    tracer.inject(activeSpan, 'text_map', attributes)

    // Inject upper 64 bits of 128-bit trace ID for proper span linking
    const traceIdUpperBits = activeSpan.context()._trace.tags['_dd.p.tid']
    if (traceIdUpperBits) attributes['_dd.p.tid'] = traceIdUpperBits
  } catch {
    // Silently fail - trace context injection is best-effort
  }

  // Add metadata for consumer correlation
  if (pubsub) attributes['gcloud.project_id'] = pubsub.projectId
  if (topicName) attributes['pubsub.topic'] = topicName
}

// Inject trace context into messages at queue time
addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  log.debug(`[DD DEBUG] Topic wrapper hook called, obj.Topic exists: ${!!obj.Topic}`)
  if (!obj.Topic?.prototype) return obj

  // Wrap Topic.publishMessage (modern API)
  if (obj.Topic.prototype.publishMessage) {
    log.debug('[DD DEBUG] Wrapping Topic.publishMessage')
    shimmer.wrap(obj.Topic.prototype, 'publishMessage', publishMessage => function (data) {
      log.debug(`[DD DEBUG] Topic.publishMessage called with data: ${!!data}`)
      if (data && typeof data === 'object') {
        if (!data.attributes) data.attributes = {}
        try {
          injectTraceContext(data.attributes, this.pubsub, this.name)
        } catch (err) {
          log.debug(`[DD DEBUG] injectTraceContext error: ${err}`)
        }
      }
      return publishMessage.apply(this, arguments)
    })
  }

  // Wrap Topic.publish (legacy API) - signature: (data, [attributes], [callback])
  if (obj.Topic.prototype.publish) {
    log.debug('[DD DEBUG] Wrapping Topic.publish')
    shimmer.wrap(obj.Topic.prototype, 'publish', publish => function (data, attributesOrCallback, callback) {
      log.debug(
        `[DD DEBUG] Topic.publish called, args: ${arguments.length}, ` +
        `data type: ${typeof data}, arg2 type: ${typeof attributesOrCallback}`
      )
      try {
        // Only inject if attributes object is provided (and it's not a function/callback)
        if (attributesOrCallback &&
            typeof attributesOrCallback === 'object' &&
            typeof attributesOrCallback !== 'function' &&
            !Array.isArray(attributesOrCallback) &&
            !Buffer.isBuffer(attributesOrCallback)) {
          log.debug('[DD DEBUG] Injecting trace context into attributes')
          injectTraceContext(attributesOrCallback, this.pubsub, this.name)
        } else {
          log.debug('[DD DEBUG] Skipping trace injection - no attributes object')
        }
      } catch (err) {
        log.debug(`[DD DEBUG] Trace injection error: ${err}`)
      }
      // Pass through all arguments unchanged
      log.debug('[DD DEBUG] Calling original Topic.publish')
      return publish.apply(this, arguments)
    })
  } else {
    log.debug('[DD DEBUG] Topic.publish does not exist on this version')
  }

  return obj
})

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  const { PublisherClient, SchemaServiceClient, SubscriberClient } = obj.v1

  massWrap(PublisherClient.prototype, publisherMethods, wrapMethod)
  massWrap(SubscriberClient.prototype, subscriberMethods, wrapMethod)

  if (SchemaServiceClient) {
    massWrap(SchemaServiceClient.prototype, schemaServiceMethods, wrapMethod)
  }

  return obj
})
