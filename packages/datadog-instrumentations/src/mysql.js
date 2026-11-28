'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')
const {
  dispatchesAcquireSynchronously,
  takePoolWaitTime,
  wrapPoolClusterQueryMethod,
  wrapPoolGetConnection,
  wrapPoolQueryMethod,
} = require('./helpers/pool-acquire')

const connectionStartCh = channel('apm:mysql:connection:start')
const connectionFinishCh = channel('apm:mysql:connection:finish')
const acquireStartCh = channel('apm:mysql:pool:acquire:start')
const acquireFinishCh = channel('apm:mysql:pool:acquire:finish')
/** @type {WeakSet<Function>} */
const queuedCallbacks = new WeakSet()
const poolAcquireChannels = { connectionStartCh, connectionFinishCh, acquireStartCh, acquireFinishCh, queuedCallbacks }

/** @param {Function} enqueue */
function wrapDomainEnqueue (enqueue) {
  const observedQueues = new WeakSet()
  let activeQueue

  return function (callback) {
    const { domain } = /** @type {typeof process & { domain?: import('node:domain').Domain | null }} */ (process)
    let queue
    if (domain && queuedCallbacks.has(callback)) {
      queue = this._connectionQueue
      if (!observedQueues.has(queue)) {
        // MySQL creates a queue per pool and pushes the domain-bound callback before emitting enqueue.
        shimmer.wrap(queue, 'push', push => function (boundCallback) {
          if (this === activeQueue) {
            activeQueue = undefined
            if (typeof boundCallback === 'function') {
              queuedCallbacks.add(boundCallback)
            }
          }
          return push.apply(this, arguments)
        })
        observedQueues.add(queue)
      }
    }

    if (queue === undefined && activeQueue === undefined) {
      return enqueue.apply(this, arguments)
    }

    const previousQueue = activeQueue
    activeQueue = queue
    try {
      return enqueue.apply(this, arguments)
    } finally {
      activeQueue = previousQueue
    }
  }
}

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const finishCh = channel('apm:mysql:query:finish')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function (...args) {
    if (!startCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const sql = args[0].sql || args[0]
    const conf = this.config
    const ctx = { sql, conf }

    const waitTime = takePoolWaitTime(this)
    if (waitTime !== undefined && acquireStartCh.hasSubscribers) {
      ctx.poolWaitTime = waitTime
    }

    return startCh.runStores(ctx, () => {
      if (args[0].sql) {
        args[0].sql = ctx.sql
      } else {
        args[0] = ctx.sql
      }

      try {
        const res = query.apply(this, args)

        if (res._callback) {
          const cb = res._callback
          res._callback = shimmer.wrapCallback(cb, cb => function (error, result) {
            if (error) {
              ctx.error = error
              errorCh.publish(ctx)
            }
            ctx.result = result

            return finishCh.runStores(ctx, cb, this, ...arguments)
          })
        } else {
          res.once('end', () => finishCh.publish(ctx))
        }

        return res
      } catch (err) {
        void err.stack // trigger getting the stack at the original throwing point
        ctx.error = err
        errorCh.publish(ctx)

        throw err
      }
    })
  })

  return Connection
})

addHook({ name: 'mysql', file: 'lib/Pool.js', versions: ['>=2'] }, Pool => {
  const { prototype } = /** @type {{ prototype: { query: Function, _enqueueCallback?: Function } }} */ (Pool)
  const startPoolQueryCh = channel('datadog:mysql:pool:query:start')
  const finishPoolQueryCh = channel('datadog:mysql:pool:query:finish')
  const deferredPoolAcquire = !dispatchesAcquireSynchronously(
    prototype.query,
    Object.assign(Object.create(prototype), { config: { connectionConfig: {} } }),
    'getConnection',
    ['SELECT 1', () => {}]
  )

  shimmer.wrap(prototype, 'getConnection',
    getConnection => wrapPoolGetConnection(getConnection, poolAcquireChannels, deferredPoolAcquire))
  if (typeof prototype._enqueueCallback === 'function') {
    shimmer.wrap(prototype, '_enqueueCallback', wrapDomainEnqueue)
  }

  shimmer.wrap(prototype, 'query', query => wrapPoolQueryMethod(function (...args) {
    if (!startPoolQueryCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const sql = args[0].sql || args[0]
    const ctx = { sql }
    const finish = () => finishPoolQueryCh.publish(ctx)

    return startPoolQueryCh.runStores(ctx, () => {
      const cb = args.at(-1)
      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapCallback(cb, cb => function (...args) {
          return finishPoolQueryCh.runStores(ctx, cb, this, ...args)
        })
      }

      const retval = query.apply(this, args)

      if (retval && retval.then) {
        retval.then(finish).catch(finish)
      }

      return retval
    })
  }, connectionStartCh, deferredPoolAcquire))

  return Pool
})

// A `canRetry` failover re-invokes `query` with the same Query object. Key the acquire state by that
// object so a retry remains part of the query even if a future mysql version defers it.
addHook({ name: 'mysql', file: 'lib/PoolNamespace.js', versions: ['>=2'] }, PoolNamespace => {
  shimmer.wrap(PoolNamespace.prototype, 'query', query => wrapPoolClusterQueryMethod(query, poolAcquireChannels))

  return PoolNamespace
})
