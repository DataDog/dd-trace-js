'use strict'

const { addHook, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function wrapRequest (original) {
  return function () {
    const id = arguments.length - 1
    arguments[id] = AsyncResource.bind(arguments[id])
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
