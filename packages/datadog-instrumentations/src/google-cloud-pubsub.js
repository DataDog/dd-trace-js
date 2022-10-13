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

const receiveStartCh = channel(`apm:google-cloud-pubsub:receive:start`)
const receiveFinishCh = channel('apm:google-cloud-pubsub:receive:finish')
const receiveErrorCh = channel('apm:google-cloud-pubsub:receive:error')

addHook({ name: '@google-cloud/pubsub', versions: ['>=1.2'] }, (obj) => {
  const PubSub = obj.PubSub
  const Subscription = obj.Subscription

  shimmer.wrap(PubSub.prototype, 'request', request => function (cfg = { reqOpts: {} }, cb) {
    if (!requestStartCh.hasSubscribers) {
      return request.apply(this, arguments)
    }

    const innerAsyncResource = new AsyncResource('bound-anonymous-fn')
    const outerAsyncResource = new AsyncResource('bound-anonymous-fn')

    return innerAsyncResource.runInAsyncScope(() => {
      let messages = []
      if (cfg.reqOpts && cfg.method === 'publish') {
        messages = cfg.reqOpts.messages
      }

      requestStartCh.publish({ cfg, projectId: this.projectId, messages })
      cb = outerAsyncResource.bind(cb)

      const fn = () => {
        arguments[1] = innerAsyncResource.bind(function (error) {
          if (error) {
            requestErrorCh.publish(error)
          }
          requestFinishCh.publish(undefined)
          return cb.apply(this, arguments)
        })
        return request.apply(this, arguments)
      }

      try {
        return fn.apply(this, arguments)
      } catch (e) {
        requestErrorCh.publish(e)
        throw e
      }
    })
  })

  shimmer.wrap(Subscription.prototype, 'emit', emit => function (eventName, message) {
    if (eventName !== 'message' || !message) return emit.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      try {
        return emit.apply(this, arguments)
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
    return dispense.apply(this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'remove', remove => function (message) {
    receiveFinishCh.publish({ message })
    return remove.apply(this, arguments)
  })

  shimmer.wrap(LeaseManager.prototype, 'clear', clear => function () {
    for (const message of this._messages) {
      receiveFinishCh.publish({ message })
    }
    return clear.apply(this, arguments)
  })

  return obj
})
