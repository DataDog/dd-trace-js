'use strict'

const {
  channel,
  addHook,
  AsyncResource
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
    if (!requestStartCh.hasSubscribers) return Reflect.apply(method, this, arguments)

    const innerAsyncResource = new AsyncResource('bound-anonymous-fn')

    return innerAsyncResource.runInAsyncScope(() => {
      const projectId = this.auth._cachedProjectId
      const cb = arguments[arguments.length - 1]

      requestStartCh.publish({ request, api, projectId })

      if (typeof cb === 'function') {
        const outerAsyncResource = new AsyncResource('bound-anonymous-fn')

        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => innerAsyncResource.bind(function (error) {
          if (error) {
            requestErrorCh.publish(error)
          }

          requestFinishCh.publish()

          return outerAsyncResource.runInAsyncScope(() => Reflect.apply(cb, this, arguments))
        }))

        return Reflect.apply(method, this, arguments)
      } else {
        return Reflect.apply(method, this, arguments)
          .then(
            response => {
              requestFinishCh.publish()
              return response
            },
            error => {
              requestErrorCh.publish(error)
              requestFinishCh.publish()
              throw error
            }
          )
      }
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
    if (eventName !== 'message' || !message) return Reflect.apply(emit, this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      try {
        return Reflect.apply(emit, this, arguments)
      } catch (err) {
        receiveErrorCh.publish(err)
        throw err
      }
    })
  })

  return obj
})

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'], file: 'build/src/lease-manager.js' }, (obj) => {
  const LeaseManager = obj.LeaseManager

  shimmer.wrap(LeaseManager.prototype, '_dispense', dispense => function (message) {
    if (receiveStartCh.hasSubscribers) {
      receiveStartCh.publish({ message })
    }
    return Reflect.apply(dispense, this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'remove', remove => function (message) {
    receiveFinishCh.publish({ message })
    return Reflect.apply(remove, this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'clear', clear => function () {
    for (const message of this._messages) {
      receiveFinishCh.publish({ message })
    }
    return Reflect.apply(clear, this, arguments)
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
