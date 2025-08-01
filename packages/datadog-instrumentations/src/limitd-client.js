'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const callbackStartCh = channel('apm:limitd-client:callback:start')
const callbackFinishCh = channel('apm:limitd-client:callback:finish')

function wrapRequest (original) {
  return function () {
    const id = arguments.length - 1
    const callback = arguments[id]
    const ctx = {}

    if (typeof callback === 'function') {
      let cb = callback
      callbackStartCh.runStores(ctx, () => {
        cb = function () {
          return callbackFinishCh.runStores(ctx, () => {
            return callback.apply(this, arguments)
          })
        }
      })
      arguments[id] = cb
    }

    return original.apply(this, arguments)
  }
}

addHook({
  name: 'limitd-client',
  versions: ['>=2.8']
}, LimitdClient => {
  shimmer.wrap(LimitdClient.prototype, '_directRequest', wrapRequest)
  shimmer.wrap(LimitdClient.prototype, '_retriedRequest', wrapRequest)
  return LimitdClient
})
