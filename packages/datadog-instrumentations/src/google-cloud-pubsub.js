'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { storage } = require('../../datadog-core')

const requestStartCh = channel('apm:google-cloud-pubsub:request:start')
const requestFinishCh = channel('apm:google-cloud-pubsub:request:finish')
const requestErrorCh = channel('apm:google-cloud-pubsub:request:error')

const receiveStartCh = channel('apm:google-cloud-pubsub:receive:start')
const receiveFinishCh = channel('apm:google-cloud-pubsub:receive:finish')
const receiveErrorCh = channel('apm:google-cloud-pubsub:receive:error')

// Message-level channels for trace context injection
const messagePublishCh = channel('apm:google-cloud-pubsub:message:publish')
// Use WeakMap + WeakRef + FinalizationRegistry pattern for automatic GC cleanup
// No TTL needed - GC handles cleanup naturally even if acknowledge() never called
const messageToContext = new WeakMap() // WeakMap<Message, context> - auto-cleanup on GC
const ackIdToMessage = new Map() // Map<ackId, WeakRef<Message>> - doesn't prevent GC
// FinalizationRegistry cleans up Map entries when Messages are GC'd
// This handles network failures, crashes, or any case where acknowledge() isn't called
const ackMapCleanup = new FinalizationRegistry((ackId) => {
  ackIdToMessage.delete(ackId)
})

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

    // For acknowledge/modifyAckDeadline, try to restore span context from stored maps
    let restoredStore = null
    const isAckOperation = api === 'acknowledge' || api === 'modifyAckDeadline'
    if (isAckOperation && request?.ackIds?.length > 0) {
      // Try to find a stored context for any of these ack IDs
      for (const ackId of request.ackIds) {
        const weakRef = ackIdToMessage.get(ackId)
        if (weakRef) {
          const message = weakRef.deref() // Get Message if still alive
          if (message) {
            const context = messageToContext.get(message)
            if (context) {
              restoredStore = context
              break
            }
          }
        }
      }

      // Clean up Map entries immediately after acknowledge (happy path)
      // FinalizationRegistry handles cleanup if Message was already GC'd
      if (api === 'acknowledge') {
        request.ackIds.forEach(ackId => {
          ackIdToMessage.delete(ackId)
        })
      }
    }

    const ctx = { request, api, projectId: this.auth._cachedProjectId }

    if (restoredStore) {
      const parentSpan = restoredStore.span
      if (parentSpan) {
        ctx.parentSpan = parentSpan
      }
      return storage('legacy').run(restoredStore, () => {
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

    // For pull subscriptions, emit is called when message is received
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

  if (Message?.prototype?.ack) {
    shimmer.wrap(Message.prototype, 'ack', originalAck => function () {
      const currentStore = storage('legacy').getStore()
      const activeSpan = currentStore && currentStore.span

      if (activeSpan && this.ackId) {
        const storeWithSpanContext = { ...currentStore, span: activeSpan }

        // Store context in WeakMap using Message object as key
        messageToContext.set(this, storeWithSpanContext)

        // Store WeakRef (not hard reference) in Map
        // This allows GC to collect Message even if acknowledge() never called
        const weakRef = new WeakRef(this)
        ackIdToMessage.set(this.ackId, weakRef)

        // Register for cleanup when Message is GC'd
        // This handles network failures, crashes, or missing acknowledge() calls
        ackMapCleanup.register(this, this.ackId, this)
      }

      return originalAck.apply(this, arguments)
    })
  }

  return obj
})

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/lease-manager.js' }, (obj) => {
  const LeaseManager = obj.LeaseManager
  if (!LeaseManager) {
    return obj
  }

  const messageContexts = new WeakMap()

  shimmer.wrap(LeaseManager.prototype, '_dispense', dispense => function (message) {
    const ctx = { message }
    messageContexts.set(message, ctx)

    return receiveStartCh.runStores(ctx, dispense, this, ...arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'remove', remove => function (message) {
    const ctx = messageContexts.get(message) || { message }
    messageContexts.delete(message)

    return receiveFinishCh.runStores(ctx, remove, this, ...arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'clear', clear => function () {
    // Finish spans for all messages still in the lease before clearing
    if (this._messages) {
      for (const message of this._messages.values()) {
        const ctx = messageContexts.get(message)
        if (ctx) {
          receiveFinishCh.publish(ctx)
          messageContexts.delete(message)
        }
      }
    }
    return clear.apply(this, arguments)
  })

  return obj
})

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  if (!obj.Topic?.prototype) return obj

  if (typeof obj.Topic.prototype.publishMessage === 'function') {
    shimmer.wrap(obj.Topic.prototype, 'publishMessage', publishMessage => {
      return function (data, attributesOrCallback, callback) {
        if (data && typeof data === 'object') {
          if (!data.attributes) data.attributes = {}
          // Publish event for plugins to inject trace context
          messagePublishCh.publish({
            attributes: data.attributes,
            pubsub: this.pubsub,
            topicName: this.name
          })
        }
        return publishMessage.apply(this, arguments)
      }
    })
  }

  if (typeof obj.Topic.prototype.publish === 'function') {
    shimmer.wrap(obj.Topic.prototype, 'publish', publish => function (buffer, attributesOrCallback, callback) {
      if (typeof attributesOrCallback === 'function' || !attributesOrCallback) {
        arguments[1] = {}
        arguments[2] = attributesOrCallback
      }

      // Publish event for plugins to inject trace context
      messagePublishCh.publish({
        attributes: arguments[1],
        pubsub: this.pubsub,
        topicName: this.name,
        buffer
      })

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
