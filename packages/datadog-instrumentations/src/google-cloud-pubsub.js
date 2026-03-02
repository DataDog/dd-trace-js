'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const requestStartCh = channel('apm:google-cloud-pubsub:request:start')
const requestFinishCh = channel('apm:google-cloud-pubsub:request:finish')
const requestErrorCh = channel('apm:google-cloud-pubsub:request:error')

const receiveStartCh = channel('apm:google-cloud-pubsub:receive:start')
const receiveFinishCh = channel('apm:google-cloud-pubsub:receive:finish')
const receiveErrorCh = channel('apm:google-cloud-pubsub:receive:error')

/**
 * Message-level channels for trace context injection and async context propagation:
 * - messagePublishCh: Inject trace context when Topic.publish() is called
 * - messageAckStoreCh: Store async context when message.ack() is called (PULL)
 * - messageAckRetrieveCh: Retrieve stored context when acknowledge() API is called (PULL)
 * - messageStoreCh: Propagate context when Subscription emits 'message' event (PULL)
 */
const messagePublishCh = channel('apm:google-cloud-pubsub:message:publish')
const messageAckStoreCh = channel('apm:google-cloud-pubsub:message:ack-store')
const messageAckRetrieveCh = channel('apm:google-cloud-pubsub:message:ack-retrieve')
const messageStoreCh = channel('apm:google-cloud-pubsub:message:store')

// WeakMap for passing context between LeaseManager._dispense and LeaseManager.remove
const messageContexts = new WeakMap()

const publisherMethods = [
  'createTopic',
  'updateTopic',
  'publish',
  'getTopic',
  'listTopics',
  'listTopicSubscriptions',
  'listTopicSnapshots',
  'deleteTopic',
  'detachSubscription',
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
  'validateMessage',
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
  'seek',
]

function wrapMethod (method) {
  const api = method.name

  return function (request) {
    if (!requestStartCh.hasSubscribers) return method.apply(this, arguments)

    const ctx = { request, api, projectId: this.auth._cachedProjectId }

    /**
     * For acknowledge/modifyAckDeadline: retrieve stored context from consumer plugin.
     * These APIs only have ackIds (no Message objects), so async context is lost.
     * Plugin sets ctx.storedContext, which client.js uses to link the acknowledge span.
     */
    const isAckOperation = api === 'acknowledge' || api === 'modifyAckDeadline'
    if (isAckOperation && request?.ackIds?.length > 0) {
      messageAckRetrieveCh.publish({
        ackIds: request.ackIds,
        api,
        ctx,
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

  /**
   * PULL: Intercept 'message' events and propagate async context via runStores.
   * This ensures the consumer plugin creates spans in the correct context.
   */
  shimmer.wrap(Subscription.prototype, 'emit', emit => function (eventName, message) {
    if (eventName !== 'message' || !message) return emit.apply(this, arguments)

    const ctx = { message }
    try {
      return messageStoreCh.runStores(ctx, emit, this, ...arguments)
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

  /**
   * PULL: Capture async context when message.ack() is called.
   * This is our last chance before context is lost. The acknowledge() API call happens
   * later (often batched), and we'll retrieve this stored context to link spans.
   * Flow: message.ack() -> store context -> acknowledge() API -> retrieve context
   */
  if (Message?.prototype?.ack) {
    shimmer.wrap(Message.prototype, 'ack', originalAck => function () {
      if (this.ackId) {
        const ctx = {
          message: this,
          ackId: this.ackId,
        }

        return messageAckStoreCh.runStores(ctx, originalAck, this, ...arguments)
      }

      return originalAck.apply(this, arguments)
    })
  }

  return obj
})

/**
 * PULL: Hook LeaseManager to track message lifecycle (dispense/remove/clear).
 * _dispense: Message given to handler -> create span
 * remove: Message removed from lease (ack/nack/timeout) -> finish span
 * clear: Subscription closed -> finish all remaining spans
 */
addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/lease-manager.js' }, (obj) => {
  const LeaseManager = obj.LeaseManager
  if (!LeaseManager) {
    return obj
  }

  shimmer.wrap(LeaseManager.prototype, '_dispense', dispense => function (message) {
    const ctx = { message }
    messageContexts.set(message, ctx)

    return receiveStartCh.runStores(ctx, dispense, this, ...arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'remove', remove => function (message) {
    const ctx = messageContexts.get(message)
    if (ctx) {
      messageContexts.delete(message)
    }

    return receiveFinishCh.runStores(ctx || { message }, remove, this, ...arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'clear', clear => function () {
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

/**
 * Inject trace context into individual messages via Topic.publish()/publishMessage().
 * Flow: User calls topic.publish() -> inject context (here) -> SDK batches messages ->
 * publish() API called -> producer plugin creates batch span + metadata
 */
addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  if (!obj.Topic?.prototype) return obj

  if (typeof obj.Topic.prototype.publishMessage === 'function') {
    shimmer.wrap(obj.Topic.prototype, 'publishMessage', publishMessage => {
      return function (data, attributesOrCallback, callback) {
        if (data && typeof data === 'object') {
          if (!data.attributes) data.attributes = {}
          messagePublishCh.publish({
            attributes: data.attributes,
            pubsub: this.pubsub,
            topicName: this.name,
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

      messagePublishCh.publish({
        attributes: arguments[1],
        pubsub: this.pubsub,
        topicName: this.name,
        buffer,
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
