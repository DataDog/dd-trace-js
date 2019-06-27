'use strict'

function createWrapAcquire (tracer, config) {
  return function wrapAcquire (acquire) {
    return function acquireWithTrace (callback, priority) {
      return acquire.call(this, tracer.scope().bind(callback), priority)
    }
  }
}

function createWrapPool (tracer, config, instrumenter) {
  return function wrapPool (Pool) {
    return function PoolWithTrace (factory) {
      const pool = Pool.apply(this, arguments)

      instrumenter.wrap(pool, 'acquire', createWrapAcquire(tracer, config))

      return pool
    }
  }
}

module.exports = [
  {
    name: 'generic-pool',
    versions: ['^2.4'],
    patch (genericPool, tracer, config) {
      this.wrap(genericPool.Pool.prototype, 'acquire', createWrapAcquire(tracer, config))
    },
    unpatch (genericPool) {
      this.unwrap(genericPool.Pool.prototype, 'acquire')
    }
  },
  {
    name: 'generic-pool',
    versions: ['2 - 2.3'],
    patch (genericPool, tracer, config) {
      this.wrap(genericPool, 'Pool', createWrapPool(tracer, config, this))
    },
    unpatch (genericPool) {
      this.unwrap(genericPool, 'Pool')
    }
  }
]
