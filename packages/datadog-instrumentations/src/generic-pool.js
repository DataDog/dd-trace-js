'use strict'

const { addHook, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function createWrapAcquire () {
  return function wrapAcquire (acquire) {
    return function acquireWithTrace (callback, priority) {
      if (typeof callback === 'function') {
        arguments[0] = AsyncResource.bind(callback)
      }

      return acquire.apply(this, arguments)
    }
  }
}

function createWrapPool () {
  return function wrapPool (Pool) {
    if (typeof Pool !== 'function') return Pool

    return function PoolWithTrace (factory) {
      const pool = Pool.apply(this, arguments)

      if (pool && typeof pool.acquire === 'function') {
        shimmer.wrap(pool, 'acquire', createWrapAcquire())
      }

      return pool
    }
  }
}

addHook({
  name: 'generic-pool',
  versions: ['^2.4']
}, genericPool => {
  shimmer.wrap(genericPool.Pool.prototype, 'acquire', createWrapAcquire())
  return genericPool
})

addHook({
  name: 'generic-pool',
  versions: ['2 - 2.3']
}, genericPool => {
  shimmer.wrap(genericPool, 'Pool', createWrapPool())
  return genericPool
})
