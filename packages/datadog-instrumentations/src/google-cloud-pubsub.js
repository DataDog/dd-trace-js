'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { storage } = require('../../datadog-core')

// Auto-load push subscription plugin to enable pubsub.delivery spans for push subscriptions
try {
  const PushSubscriptionPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
  new PushSubscriptionPlugin(null, {}).configure({})
} catch {
  // Push subscription plugin is optional
}

const requestStartCh = channel('apm:google-cloud-pubsub:request:start')
const requestFinishCh = channel('apm:google-cloud-pubsub:request:finish')
const requestErrorCh = channel('apm:google-cloud-pubsub:request:error')

const receiveStartCh = channel('apm:google-cloud-pubsub:receive:start')
const receiveFinishCh = channel('apm:google-cloud-pubsub:receive:finish')
const receiveErrorCh = channel('apm:google-cloud-pubsub:receive:error')

const ackContextMap = new Map()

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
    if (!requestStartCh.hasSubscribers) return method.apply(this, arguments)

    // For acknowledge/modifyAckDeadline, try to restore span context from stored map
    let restoredStore = null
    const isAckOperation = api === 'acknowledge' || api === 'modifyAckDeadline'
    if (isAckOperation && request && request.ackIds && request.ackIds.length > 0) {
      // Try to find a stored context for any of these ack IDs
      for (const ackId of request.ackIds) {
        const storedContext = ackContextMap.get(ackId)
        if (storedContext) {
          restoredStore = storedContext
          break
        }
      }

      if (api === 'acknowledge') {
        request.ackIds.forEach(ackId => {
          if (ackContextMap.has(ackId)) {
            ackContextMap.delete(ackId)
          }
        })
      }
    }

    const ctx = { request, api, projectId: this.auth._cachedProjectId }

    if (restoredStore) {
      const parentSpan = restoredStore.span
      if (parentSpan) {
        ctx.parentSpan = parentSpan
      }
      const self = this
      const args = arguments
      return storage('legacy').run(restoredStore, () => {
        return requestStartCh.runStores(ctx, () => {
          const cb = args[args.length - 1]

          if (typeof cb === 'function') {
            args[args.length - 1] = shimmer.wrapFunction(cb, cb => function (error) {
              if (error) {
                ctx.error = error
                requestErrorCh.publish(ctx)
              }
              return requestFinishCh.runStores(ctx, cb, this, ...arguments)
            })
            return method.apply(self, args)
          }

          return method.apply(self, args)
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
      })
    }

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
  for (const method of methods) {
    if (typeof obj[method] === 'function') {
      shimmer.wrap(obj, method, wrapper)
    }
  }
}

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  const Subscription = obj.Subscription

  shimmer.wrap(Subscription.prototype, 'emit', emit => function (eventName, message) {
    if (eventName !== 'message' || !message) return emit.apply(this, arguments)

    const store = storage('legacy').getStore()
    const ctx = { message, store }
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

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/subscriber.js' }, (obj) => {
  const Message = obj.Message

  if (Message && Message.prototype && Message.prototype.ack) {
    shimmer.wrap(Message.prototype, 'ack', originalAck => function () {
      const currentStore = storage('legacy').getStore()
      const activeSpan = currentStore && currentStore.span

      if (activeSpan) {
        const storeWithSpanContext = { ...currentStore, span: activeSpan }

        if (this.ackId) {
          ackContextMap.set(this.ackId, storeWithSpanContext)
        }
      }

      return originalAck.apply(this, arguments)
    })
  }

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

function injectTraceContext (attributes, pubsub, topicName) {
  if (attributes['x-datadog-trace-id'] || attributes.traceparent) return

  try {
    const tracer = require('../../dd-trace')
    const activeSpan = tracer.scope().active()
    if (!activeSpan) return

    tracer.inject(activeSpan, 'text_map', attributes)

    const traceIdUpperBits = activeSpan.context()._trace.tags['_dd.p.tid']
    if (traceIdUpperBits) attributes['_dd.p.tid'] = traceIdUpperBits
  } catch {
    // Silently fail - trace context injection is best-effort
  }

  if (pubsub) attributes['gcloud.project_id'] = pubsub.projectId
  if (topicName) attributes['pubsub.topic'] = topicName
}

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  if (!obj.Topic?.prototype) return obj

  // Wrap Topic.publishMessage (modern API)
  if (obj.Topic.prototype.publishMessage) {
    shimmer.wrap(obj.Topic.prototype, 'publishMessage', publishMessage => function (data) {
      if (data && typeof data === 'object') {
        if (!data.attributes) data.attributes = {}
        injectTraceContext(data.attributes, this.pubsub, this.name)
      }
      return publishMessage.apply(this, arguments)
    })
  }

  // Wrap Topic.publish (legacy API)
  if (obj.Topic.prototype.publish) {
    shimmer.wrap(obj.Topic.prototype, 'publish', publish => function (buffer, attributesOrCallback, callback) {
      if (typeof attributesOrCallback === 'function' || !attributesOrCallback) {
        arguments[1] = {}
        arguments[2] = attributesOrCallback
      }
      injectTraceContext(arguments[1], this.pubsub, this.name)
      return publish.apply(this, arguments)
    })
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
