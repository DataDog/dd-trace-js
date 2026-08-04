'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, AsyncResource } = require('./helpers/instrument')

function wrapRequest (original) {
  return function (...args) {
    const id = args.length - 1
    args[id] = AsyncResource.bind(args[id])
    return original.apply(this, args)
  }
}

addHook({
  name: 'limitd-client',
  versions: ['>=2.8'],
  file: 'client.js',
}, LimitdClient => {
  shimmer.wrap(LimitdClient.prototype, '_directRequest', wrapRequest)
  shimmer.wrap(LimitdClient.prototype, '_retriedRequest', wrapRequest)
  return LimitdClient
})
