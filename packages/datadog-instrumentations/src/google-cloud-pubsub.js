'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

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
    if (!requestStartCh.hasSubscribers) return method.apply(this, arguments)

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

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  const { PublisherClient, SchemaServiceClient, SubscriberClient } = obj.v1

  massWrap(PublisherClient.prototype, publisherMethods, wrapMethod)
  massWrap(SubscriberClient.prototype, subscriberMethods, wrapMethod)

  if (SchemaServiceClient) {
    massWrap(SchemaServiceClient.prototype, schemaServiceMethods, wrapMethod)
  }

  return obj
})
