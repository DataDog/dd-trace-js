'use strict'

const LOG_PREFIX = '[DD-PUBSUB-INST]'
console.log(`${LOG_PREFIX} ========================================`)
console.log(`${LOG_PREFIX} LOADING google-cloud-pubsub instrumentation at ${new Date().toISOString()}`)
console.log(`${LOG_PREFIX} ========================================`)

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { storage } = require('../../datadog-core')

console.log(`${LOG_PREFIX} Attempting to load PushSubscriptionPlugin`)
try {
  const PushSubscriptionPlugin = require('../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription')
  new PushSubscriptionPlugin(null, {}).configure({})
  console.log(`${LOG_PREFIX} PushSubscriptionPlugin loaded successfully`)
} catch (e) {
  console.log(`${LOG_PREFIX} PushSubscriptionPlugin not loaded: ${e.message}`)
}

console.log(`${LOG_PREFIX} Creating diagnostic channels`)
const requestStartCh = channel('apm:google-cloud-pubsub:request:start')
const requestFinishCh = channel('apm:google-cloud-pubsub:request:finish')
const requestErrorCh = channel('apm:google-cloud-pubsub:request:error')

const receiveStartCh = channel('apm:google-cloud-pubsub:receive:start')
const receiveFinishCh = channel('apm:google-cloud-pubsub:receive:finish')
const receiveErrorCh = channel('apm:google-cloud-pubsub:receive:error')

console.log(`${LOG_PREFIX} Diagnostic channels created successfully`)
console.log(`${LOG_PREFIX} receiveStartCh.hasSubscribers = ${receiveStartCh.hasSubscribers}`)
console.log(`${LOG_PREFIX} receiveFinishCh.hasSubscribers = ${receiveFinishCh.hasSubscribers}`)

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

console.log(`${LOG_PREFIX} Registering hook #1: Subscription.emit wrapper`)
addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  const Subscription = obj.Subscription
  console.log(`${LOG_PREFIX} Hook #1 FIRED: Wrapping Subscription.emit (Subscription found: ${!!Subscription})`)

  shimmer.wrap(Subscription.prototype, 'emit', emit => function (eventName, message) {
    if (eventName !== 'message' || !message) return emit.apply(this, arguments)

    console.log('[google-cloud-pubsub instrumentation] Subscription.emit called with message:', message?.id)
    const store = storage('legacy').getStore()
    const ctx = { message, store }
    try {
      return emit.apply(this, arguments)
    } catch (err) {
      console.log('[google-cloud-pubsub instrumentation] Error in Subscription.emit:', err.message)
      ctx.error = err
      receiveErrorCh.publish(ctx)
      throw err
    }
  })

  return obj
})

// Hook Message.ack to store span context for acknowledge operations
console.log(`${LOG_PREFIX} Registering hook #2: Message.ack wrapper (file: build/src/subscriber.js)`)
addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/subscriber.js' }, (obj) => {
  const Message = obj.Message
  console.log(`${LOG_PREFIX} Hook #2 FIRED: build/src/subscriber.js loaded (Message found: ${!!Message})`)

  if (Message && Message.prototype && Message.prototype.ack) {
    console.log('[google-cloud-pubsub instrumentation] Wrapping Message.ack')
    shimmer.wrap(Message.prototype, 'ack', originalAck => function () {
      console.log('[google-cloud-pubsub instrumentation] Message.ack called for message:', this.id)
      const currentStore = storage('legacy').getStore()
      const activeSpan = currentStore && currentStore.span

      if (activeSpan) {
        const storeWithSpanContext = { ...currentStore, span: activeSpan }

        if (this.ackId) {
          console.log('[google-cloud-pubsub instrumentation] Storing span context for ackId:', this.ackId)
          ackContextMap.set(this.ackId, storeWithSpanContext)
        }
      } else {
        console.log('[google-cloud-pubsub instrumentation] No active span found during ack')
      }

      return originalAck.apply(this, arguments)
    })
  }

  return obj
})

// Hook LeaseManager to create consumer spans
console.log(`${LOG_PREFIX} Registering hook #3: LeaseManager wrapper (file: build/src/lease-manager.js)`)
addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/lease-manager.js' }, (obj) => {
  const LeaseManager = obj.LeaseManager

  console.log(`${LOG_PREFIX} Hook #3 FIRED: build/src/lease-manager.js loaded (LeaseManager found: ${!!LeaseManager})`)
  
  if (!LeaseManager) {
    console.log(`${LOG_PREFIX} ERROR: LeaseManager not found in exports - consumer instrumentation will NOT work!`)
    return obj
  }

  console.log(`${LOG_PREFIX} Wrapping LeaseManager._dispense, .remove, and .clear methods`)
  console.log(`${LOG_PREFIX} Current subscriber count - receiveStartCh: ${receiveStartCh.hasSubscribers}, receiveFinishCh: ${receiveFinishCh.hasSubscribers}`)

  // Store contexts by message ID so we can retrieve them in remove()
  const messageContexts = new WeakMap()

  shimmer.wrap(LeaseManager.prototype, '_dispense', dispense => function (message) {
    const timestamp = new Date().toISOString()
    const hasSubscribers = receiveStartCh.hasSubscribers
    console.log(`${LOG_PREFIX} [${timestamp}] _dispense() called - messageId: ${message?.id}, hasSubscribers: ${hasSubscribers}`)
    
    if (hasSubscribers) {
      console.log(`${LOG_PREFIX} Publishing to receiveStartCh and running dispense with context`)
      const ctx = { message }
      // Store the context so we can retrieve it in remove()
      messageContexts.set(message, ctx)
      return receiveStartCh.runStores(ctx, dispense, this, ...arguments)
    } else {
      console.log(`${LOG_PREFIX} !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`)
      console.log(`${LOG_PREFIX} !!!!! CRITICAL: NO SUBSCRIBERS ON receiveStartCh !!!!!`)
      console.log(`${LOG_PREFIX} !!!!! Consumer plugin was NOT instantiated or configured !!!!!`)
      console.log(`${LOG_PREFIX} !!!!! Consumer spans will NOT be created !!!!!`)
      console.log(`${LOG_PREFIX} !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`)
    }
    return dispense.apply(this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'remove', remove => function (message) {
    const timestamp = new Date().toISOString()
    console.log(`${LOG_PREFIX} [${timestamp}] remove() called - messageId: ${message?.id}, hasSubscribers: ${receiveFinishCh.hasSubscribers}`)
    
    // Retrieve the context from _dispense
    const ctx = messageContexts.get(message) || { message }
    console.log(`${LOG_PREFIX} Context retrieved: hasCurrentStore=${!!ctx.currentStore}, hasParentStore=${!!ctx.parentStore}`)
    
    if (receiveFinishCh.hasSubscribers) {
      // Clean up the stored context
      messageContexts.delete(message)
      return receiveFinishCh.runStores(ctx, remove, this, ...arguments)
    } else {
      console.log(`${LOG_PREFIX} WARNING: receiveFinishCh has no subscribers!`)
    }
    return remove.apply(this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'clear', clear => function () {
    console.log(`${LOG_PREFIX} clear() called - clearing ${this._messages?.size || 0} messages`)
    for (const message of this._messages) {
      // Retrieve the context from _dispense
      const ctx = messageContexts.get(message) || { message }
      console.log(`${LOG_PREFIX} Publishing finish for message ${message?.id}, hasCurrentStore=${!!ctx.currentStore}`)
      receiveFinishCh.publish(ctx)
      messageContexts.delete(message)
    }
    return clear.apply(this, arguments)
  })

  console.log(`${LOG_PREFIX} LeaseManager wrapper installation COMPLETE`)
  return obj
})

console.log(`${LOG_PREFIX} ========================================`)
console.log(`${LOG_PREFIX} google-cloud-pubsub instrumentation LOADED`)
console.log(`${LOG_PREFIX} ========================================`)

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

  if (typeof obj.Topic.prototype.publishMessage === 'function') {
    shimmer.wrap(obj.Topic.prototype, 'publishMessage', publishMessage => {
      return function (data, attributesOrCallback, callback) {
        if (data && typeof data === 'object') {
          if (!data.attributes) data.attributes = {}
          injectTraceContext(data.attributes, this.pubsub, this.name)
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
