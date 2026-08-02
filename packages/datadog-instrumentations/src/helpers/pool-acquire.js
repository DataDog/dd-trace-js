'use strict'

const { performance } = require('node:perf_hooks')

/**
 * @typedef {import('node:diagnostics_channel').Channel} Channel
 * @typedef {{ key?: object, start?: number }} ClusterAcquire
 * @typedef {{ _freeConnections?: { length: number } }} Pool
 * @typedef {{ deferred: boolean }} PoolWaitTransfer
 * @typedef {{ transfer: PoolWaitTransfer, waitTime: number }} DeferredPoolWait
 * @typedef {{ pending: boolean, pool: object }} DeferredPoolQueryAcquire
 * @typedef {{
 *   connectionStartCh: Channel,
 *   connectionFinishCh: Channel,
 *   acquireStartCh: Channel,
 *   acquireFinishCh: Channel,
 *   reentersQueuedCallbacks?: boolean
 * }} AcquireChannels
 */

const poolQueryAcquire = {}

/** @type {ClusterAcquire | typeof poolQueryAcquire | undefined} */
let currentPoolQueryAcquire

/** @type {import('node:async_hooks').AsyncLocalStorage<DeferredPoolQueryAcquire>|undefined} */
let deferredPoolQueryAcquireStorage

/** @type {WeakMap<object, ClusterAcquire>} */
const deferredClusterAcquires = new WeakMap()

// Keep synchronous wait handoff allocation-free; a delayed consumer promotes only its pool wrapper.
const poolWaitConnections = []
const poolWaitTimes = []

/** @type {WeakMap<object, DeferredPoolWait>} */
const deferredPoolWaitTimes = new WeakMap()
let deferredPoolWaitCount = 0

/**
 * @param {Function} method
 * @param {Channel} connectionStartCh
 * @param {boolean} [deferred]
 * @returns {Function}
 */
function wrapPoolQueryMethod (method, connectionStartCh, deferred) {
  if (deferred) {
    return function () {
      if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)

      const storage = getDeferredPoolQueryAcquireStorage()
      return storage.run({ pending: true, pool: this }, () => method.apply(this, arguments))
    }
  }

  return function () {
    if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)
    return runWithPoolQueryAcquire(poolQueryAcquire, method, this, arguments)
  }
}

/**
 * @param {Function} method
 * @param {Function} inactiveMethod
 * @param {Channel} connectionStartCh
 * @param {boolean} deferred
 * @returns {Function}
 */
function wrapPoolAcquireCarrier (method, inactiveMethod, connectionStartCh, deferred) {
  if (!deferred) return method

  return function (callback) {
    if (!connectionStartCh.hasSubscribers) return inactiveMethod.apply(this, arguments)
    if (typeof callback !== 'function' || !takeDeferredPoolQueryAcquire(this)) {
      return method.apply(this, arguments)
    }

    return runWithPoolQueryAcquire(poolQueryAcquire, method, this, arguments)
  }
}

/**
 * @param {Function} method
 * @param {Channel} connectionStartCh
 * @returns {Function}
 */
function wrapPoolClusterQueryMethod (method, connectionStartCh) {
  return function () {
    if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)

    const key = arguments[0]
    const previous = currentPoolQueryAcquire
    const acquire = isClusterAcquire(previous) && previous.key === key
      ? previous
      : takeClusterAcquire(key) ?? {}
    const result = runWithPoolQueryAcquire(acquire, method, this, arguments)

    if (isWeakKey(result)) acquire.key = result
    return result
  }
}

/**
 * @param {Function} method
 * @param {Channel} connectionStartCh
 * @returns {Function}
 */
function wrapPoolClusterMethod (method, connectionStartCh) {
  return function () {
    if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)
    return runWithPoolQueryAcquire({}, method, this, arguments)
  }
}

/**
 * @param {Function} method
 * @param {Channel} connectionStartCh
 * @returns {Function}
 */
function wrapPoolClusterGetConnection (method, connectionStartCh) {
  return function (callback) {
    if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)

    const previous = currentPoolQueryAcquire
    const acquire = isClusterAcquire(previous) &&
      (previous.key === undefined || previous.key === callback)
      ? previous
      : takeClusterAcquire(callback)

    if (acquire !== undefined) acquire.key = callback
    if (acquire === undefined && previous === undefined) return method.apply(this, arguments)

    return runWithPoolQueryAcquire(acquire, method, this, arguments)
  }
}

/**
 * @param {Function} getConnection
 * @param {AcquireChannels} channels
 * @param {boolean} [deferred]
 * @returns {Function}
 */
function wrapPoolGetConnection (getConnection, channels, deferred) {
  const wrapped = wrapSynchronousPoolGetConnection(getConnection, channels)
  return wrapPoolAcquireCarrier(wrapped, getConnection, channels.connectionStartCh, deferred === true)
}

/**
 * @param {Function} getConnection
 * @param {AcquireChannels} channels
 * @returns {Function}
 */
function wrapSynchronousPoolGetConnection (getConnection, channels) {
  const {
    connectionStartCh,
    connectionFinishCh,
    acquireStartCh,
    acquireFinishCh,
  } = channels
  const poolWaitTransfer = { deferred: false }
  const queuedCallbacks = channels.reentersQueuedCallbacks ? new WeakSet() : undefined

  return function (callback) {
    if (!connectionStartCh.hasSubscribers || queuedCallbacks?.has(callback)) {
      return getConnection.apply(this, arguments)
    }

    const ctx = {}
    const acquire = currentPoolQueryAcquire
    const acquireCtx = acquire === undefined && acquireStartCh.hasSubscribers
      ? { conf: this.config.connectionConfig }
      : undefined
    const start = acquireStart(this, acquire)

    if (acquireCtx !== undefined) acquireStartCh.publish(acquireCtx)

    /**
     * @param {unknown} error
     * @param {object|undefined} connection
     * @returns {unknown}
     */
    const wrappedCallback = function (error, connection) {
      if (acquire === undefined) {
        if (!error && connection !== undefined) clearPoolWaitTime(connection)
        if (acquireCtx !== undefined) {
          acquireCtx.error = error
          acquireCtx.poolWaitTime = acquireWait(start)
          acquireFinishCh.publish(acquireCtx)
        }
        return connectionFinishCh.runStores(ctx, callback, this, ...arguments)
      }

      return runPoolQueryConnectionCallback(
        poolWaitTransfer,
        acquire,
        start,
        error,
        connection,
        connectionFinishCh,
        ctx,
        callback,
        this,
        arguments
      )
    }
    if (queuedCallbacks !== undefined) queuedCallbacks.add(wrappedCallback)
    arguments[0] = wrappedCallback

    connectionStartCh.publish(ctx)
    return acquire === undefined
      ? getConnection.apply(this, arguments)
      : runWithPoolQueryAcquire(undefined, getConnection, this, arguments)
  }
}

/**
 * @returns {boolean}
 */
function isPoolQueryAcquire () {
  return currentPoolQueryAcquire !== undefined
}

/**
 * @param {Function} method
 * @param {object} receiver
 * @param {IArguments|unknown[]} args
 * @returns {unknown}
 */
function runOutsidePoolQueryAcquire (method, receiver, args) {
  return runWithPoolQueryAcquire(undefined, method, receiver, args)
}

/**
 * @param {ClusterAcquire | typeof poolQueryAcquire | undefined} acquire
 * @param {Function} method
 * @param {unknown} receiver
 * @param {IArguments|unknown[]} args
 * @returns {unknown}
 */
function runWithPoolQueryAcquire (acquire, method, receiver, args) {
  const previous = currentPoolQueryAcquire
  currentPoolQueryAcquire = acquire
  try {
    return method.apply(receiver, args)
  } finally {
    currentPoolQueryAcquire = previous
  }
}

/**
 * @param {object} pool
 * @returns {boolean}
 */
function takeDeferredPoolQueryAcquire (pool) {
  const acquire = deferredPoolQueryAcquireStorage?.getStore()
  if (acquire === undefined || acquire.pool !== pool || !acquire.pending) return false

  acquire.pending = false
  return true
}

/**
 * @returns {import('node:async_hooks').AsyncLocalStorage<DeferredPoolQueryAcquire>}
 */
function getDeferredPoolQueryAcquireStorage () {
  if (deferredPoolQueryAcquireStorage === undefined) {
    const { AsyncLocalStorage } = require('node:async_hooks')
    deferredPoolQueryAcquireStorage = new AsyncLocalStorage()
  }
  return deferredPoolQueryAcquireStorage
}

/**
 * @param {Function} method
 * @param {Record<string, unknown>} receiver
 * @param {string} acquireMethod
 * @param {unknown[]} args
 * @returns {boolean}
 */
function dispatchesAcquireSynchronously (method, receiver, acquireMethod, args) {
  let dispatched = false
  // Prevent an async probe from executing beyond its fake acquisition.
  // eslint-disable-next-line unicorn/no-thenable
  const pending = { then () {} }

  try {
    if (method.constructor.name === 'AsyncFunction') return false

    receiver[acquireMethod] = () => {
      dispatched = true
      return pending
    }
    method.apply(receiver, args)
  } catch {
    return false
  }

  return dispatched
}

/**
 * @param {Pool} pool
 * @param {ClusterAcquire | typeof poolQueryAcquire} [acquire]
 * @returns {number|undefined}
 */
function acquireStart (pool, acquire) {
  if (isClusterAcquire(acquire) && acquire.start !== undefined) return acquire.start
  if (pool._freeConnections?.length > 0) return

  const start = performance.now()
  if (isClusterAcquire(acquire)) acquire.start = start
  return start
}

/**
 * @param {number|undefined} start
 * @returns {number}
 */
function acquireWait (start) {
  return start === undefined ? 0 : performance.now() - start
}

/**
 * @param {object} connection
 * @returns {number|undefined}
 */
function takePoolWaitTime (connection) {
  for (let i = poolWaitConnections.length - 1; i >= 0; i--) {
    if (poolWaitConnections[i] === connection) {
      poolWaitConnections[i] = undefined
      return poolWaitTimes[i]
    }
  }

  if (deferredPoolWaitCount !== 0) {
    const candidate = deferredPoolWaitTimes.get(connection)
    if (candidate !== undefined) {
      deferredPoolWaitTimes.delete(connection)
      deferredPoolWaitCount--
      candidate.transfer.deferred = true
      return candidate.waitTime
    }
  }
}

/**
 * @param {PoolWaitTransfer} transfer
 * @param {object} connection
 * @param {number} waitTime
 * @param {Channel} channel
 * @param {object} ctx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {IArguments|unknown[]} args
 * @returns {unknown}
 */
function runWithPoolWait (transfer, connection, waitTime, channel, ctx, callback, thisArg, args) {
  clearPoolWaitTime(connection)

  if (transfer.deferred) {
    deferPoolWaitTime(transfer, connection, waitTime)
    return channel.runStores(ctx, callback, thisArg, ...args)
  }

  const index = poolWaitConnections.length
  poolWaitConnections.push(connection)
  poolWaitTimes.push(waitTime)
  try {
    return channel.runStores(ctx, callback, thisArg, ...args)
  } finally {
    if (poolWaitConnections[index] !== undefined) deferPoolWaitTime(transfer, connection, waitTime)
    poolWaitConnections.pop()
    poolWaitTimes.pop()
  }
}

/**
 * @param {object} connection
 */
function clearPoolWaitTime (connection) {
  if (deferredPoolWaitCount !== 0 && deferredPoolWaitTimes.delete(connection)) deferredPoolWaitCount--
}

/**
 * @param {PoolWaitTransfer} transfer
 * @param {object} connection
 * @param {number} waitTime
 */
function deferPoolWaitTime (transfer, connection, waitTime) {
  if (!deferredPoolWaitTimes.has(connection)) deferredPoolWaitCount++
  deferredPoolWaitTimes.set(connection, { transfer, waitTime })
}

/**
 * @param {PoolWaitTransfer} poolWaitTransfer
 * @param {ClusterAcquire | typeof poolQueryAcquire} acquire
 * @param {number|undefined} start
 * @param {unknown} error
 * @param {object|undefined} connection
 * @param {Channel} connectionFinishCh
 * @param {object} ctx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {IArguments} args
 * @returns {unknown}
 */
function runPoolQueryConnectionCallback (
  poolWaitTransfer,
  acquire,
  start,
  error,
  connection,
  connectionFinishCh,
  ctx,
  callback,
  thisArg,
  args
) {
  if (error || connection === undefined) {
    if (error && isClusterAcquire(acquire)) {
      if (acquire.key !== undefined) deferredClusterAcquires.set(acquire.key, acquire)
      return runWithPoolQueryAcquire(
        acquire,
        connectionFinishCh.runStores,
        connectionFinishCh,
        [ctx, callback, thisArg, ...args]
      )
    }
    return connectionFinishCh.runStores(ctx, callback, thisArg, ...args)
  }

  if (isClusterAcquire(acquire)) {
    if (acquire.key !== undefined) deferredClusterAcquires.delete(acquire.key)
    acquire.key = undefined
  }

  return runWithPoolWait(
    poolWaitTransfer,
    connection,
    acquireWait(start),
    connectionFinishCh,
    ctx,
    callback,
    thisArg,
    args
  )
}

/**
 * @param {unknown} value
 * @returns {value is ClusterAcquire}
 */
function isClusterAcquire (value) {
  return value !== undefined && value !== poolQueryAcquire
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isWeakKey (value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/**
 * @param {unknown} key
 * @returns {ClusterAcquire|undefined}
 */
function takeClusterAcquire (key) {
  if (!isWeakKey(key)) return
  const acquire = deferredClusterAcquires.get(key)
  if (acquire !== undefined) deferredClusterAcquires.delete(key)
  return acquire
}

module.exports = {
  clearPoolWaitTime,
  dispatchesAcquireSynchronously,
  isPoolQueryAcquire,
  runOutsidePoolQueryAcquire,
  runWithPoolWait,
  takePoolWaitTime,
  wrapPoolAcquireCarrier,
  wrapPoolClusterGetConnection,
  wrapPoolClusterMethod,
  wrapPoolClusterQueryMethod,
  wrapPoolGetConnection,
  wrapPoolQueryMethod,
}
