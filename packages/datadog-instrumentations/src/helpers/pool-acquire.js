'use strict'

const { performance } = require('node:perf_hooks')

/**
 * @typedef {import('node:diagnostics_channel').Channel} Channel
 * @typedef {{ key?: object, start?: number }} ClusterAcquire
 * @typedef {{ _freeConnections?: { length: number } }} Pool
 * @typedef {{ deferred: boolean }} PoolWaitTransfer
 * @typedef {{ transfer: PoolWaitTransfer, waitTime: number }} DeferredPoolWait
 * @typedef {{ pending: boolean, pool: object }} DeferredPoolQueryAcquire
 * @typedef {(method: Function, pool: object, args: IArguments) => unknown} PoolAcquireRunner
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

const poolWaitConnections = []
const poolWaitTimes = []

// Keep synchronous dispatch on the array fast path. An unconsumed candidate remains associated with
// the connection until its first query or its next acquisition, so delayed dispatch has no timing
// assumption and an aborted dispatch cannot poison the next borrower. Consuming one after the
// acquire callback returns switches only that wrapped pool implementation to the WeakMap path.
/** @type {WeakMap<object, DeferredPoolWait>} */
const deferredPoolWaitTimes = new WeakMap()
let deferredPoolWaitCount = 0

// Ordinary pool methods identify their synchronous acquire with the sentinel. Cluster retries carry
// a keyed state so a future upstream version can defer the retry without changing its classification.
/**
 * Bracket a pool `query` / `execute` so the connection it acquires internally is treated as a
 * pooled-query acquire rather than an explicit one.
 *
 * @param {Function} method
 * @param {Channel} connectionStartCh
 * @param {boolean} [deferred]
 * @returns {Function}
 */
function wrapPoolQueryMethod (method, connectionStartCh, deferred) {
  if (deferred) return wrapPoolQueryCarrier(method, connectionStartCh, true)

  return function () {
    if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)

    const previous = currentPoolQueryAcquire
    currentPoolQueryAcquire = poolQueryAcquire
    try {
      return method.apply(this, arguments)
    } finally {
      currentPoolQueryAcquire = previous
    }
  }
}

/**
 * @param {Function} method
 * @param {Channel} connectionStartCh
 * @param {boolean} deferred
 * @returns {Function}
 */
function wrapPoolQueryCarrier (method, connectionStartCh, deferred) {
  if (!deferred) return method

  return function () {
    if (!connectionStartCh.hasSubscribers) return method.apply(this, arguments)

    return runDeferredPoolQueryAcquire(this, method, arguments)
  }
}

/**
 * @param {Function} method
 * @param {Function} inactiveMethod
 * @param {Channel} connectionStartCh
 * @param {boolean} deferred
 * @param {PoolAcquireRunner} run
 * @returns {Function}
 */
function wrapPoolAcquireCarrier (method, inactiveMethod, connectionStartCh, deferred, run) {
  if (!deferred) return method

  return function (callback) {
    if (!connectionStartCh.hasSubscribers) return inactiveMethod.apply(this, arguments)
    if (typeof callback !== 'function' || !takeDeferredPoolQueryAcquire(this)) {
      return method.apply(this, arguments)
    }

    return run(method, this, arguments)
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

    const previous = currentPoolQueryAcquire
    const key = arguments[0]
    const acquire = previous && previous !== poolQueryAcquire && previous.key === key
      ? previous
      : takeClusterAcquire(key) ?? {}

    currentPoolQueryAcquire = acquire
    try {
      const result = method.apply(this, arguments)
      if (isWeakKey(result)) acquire.key = result
      return result
    } finally {
      currentPoolQueryAcquire = previous
    }
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

    const previous = currentPoolQueryAcquire
    const acquire = {}

    currentPoolQueryAcquire = acquire
    try {
      return method.apply(this, arguments)
    } finally {
      currentPoolQueryAcquire = previous
    }
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
    const acquire = previous && previous !== poolQueryAcquire &&
      (previous.key === undefined || previous.key === callback)
      ? previous
      : takeClusterAcquire(callback)

    if (acquire === undefined) {
      if (previous === undefined) return method.apply(this, arguments)

      currentPoolQueryAcquire = undefined
      try {
        return method.apply(this, arguments)
      } finally {
        currentPoolQueryAcquire = previous
      }
    }

    acquire.key = callback
    currentPoolQueryAcquire = acquire
    try {
      return method.apply(this, arguments)
    } finally {
      currentPoolQueryAcquire = previous
    }
  }
}

/**
 * @param {Function} getConnection
 * @param {AcquireChannels} channels
 * @param {boolean} [deferred]
 * @returns {Function}
 */
function wrapPoolGetConnection (getConnection, channels, deferred) {
  if (deferred) return wrapDeferredPoolGetConnection(getConnection, channels)

  const {
    connectionStartCh,
    connectionFinishCh,
    acquireStartCh,
    acquireFinishCh,
  } = channels
  const poolWaitTransfer = { deferred: false }
  const queuedCallbacks = channels.reentersQueuedCallbacks ? new WeakSet() : undefined

  return function (callback) {
    if (!connectionStartCh.hasSubscribers) return getConnection.apply(this, arguments)
    if (queuedCallbacks?.has(callback)) return getConnection.apply(this, arguments)

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
      if (acquireCtx !== undefined) {
        acquireCtx.error = error
        acquireCtx.poolWaitTime = acquireWait(start)
        acquireFinishCh.publish(acquireCtx)
      }

      return runConnectionCallback(
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
    if (acquire === undefined) return getConnection.apply(this, arguments)

    const previous = currentPoolQueryAcquire
    currentPoolQueryAcquire = undefined
    try {
      return getConnection.apply(this, arguments)
    } finally {
      currentPoolQueryAcquire = previous
    }
  }
}

/**
 * @param {Function} getConnection
 * @param {AcquireChannels} channels
 * @returns {Function}
 */
function wrapDeferredPoolGetConnection (getConnection, channels) {
  const wrapped = wrapPoolGetConnection(getConnection, channels)

  return function () {
    if (!channels.connectionStartCh.hasSubscribers) return getConnection.apply(this, arguments)

    if (!takeDeferredPoolQueryAcquire(this)) return wrapped.apply(this, arguments)

    const previous = currentPoolQueryAcquire
    currentPoolQueryAcquire = poolQueryAcquire
    try {
      return wrapped.apply(this, arguments)
    } finally {
      currentPoolQueryAcquire = previous
    }
  }
}

/**
 * @param {object} pool
 * @param {Function} method
 * @param {IArguments|unknown[]} args
 * @returns {unknown}
 */
function runDeferredPoolQueryAcquire (pool, method, args) {
  const storage = getDeferredPoolQueryAcquireStorage()
  return storage.run({ pending: true, pool }, () => method.apply(pool, args))
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
 * An idle connection is handed back within a tick, so treat that as a zero wait and skip the clock
 * reads; only a queued or freshly established connection is worth timing. The free list is absent on
 * builds that predate it, which falls through to timing rather than crashing.
 *
 * @param {Pool} pool
 * @param {ClusterAcquire | typeof poolQueryAcquire} [acquire]
 * @returns {number|undefined}
 */
function acquireStart (pool, acquire) {
  if (acquire !== undefined && acquire !== poolQueryAcquire && acquire.start !== undefined) {
    return acquire.start
  }
  if (pool._freeConnections?.length > 0) return

  const start = performance.now()
  if (acquire !== undefined && acquire !== poolQueryAcquire) acquire.start = start
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
 * @returns {number|undefined}
 */
function startPoolWaitTransfer (transfer, connection, waitTime) {
  clearPoolWaitTime(connection)

  if (transfer.deferred) {
    deferPoolWaitTime(transfer, connection, waitTime)
    return
  }

  const index = poolWaitConnections.length
  poolWaitConnections.push(connection)
  poolWaitTimes.push(waitTime)
  return index
}

/**
 * @param {PoolWaitTransfer} transfer
 * @param {object} connection
 * @param {number} waitTime
 * @param {number|undefined} index
 */
function finishPoolWaitTransfer (transfer, connection, waitTime, index) {
  if (index === undefined) return

  if (poolWaitConnections[index] !== undefined) {
    deferPoolWaitTime(transfer, connection, waitTime)
  }
  poolWaitConnections.pop()
  poolWaitTimes.pop()
}

/**
 * @param {object} connection
 */
function clearPoolWaitTime (connection) {
  if (deferredPoolWaitCount !== 0 && deferredPoolWaitTimes.delete(connection)) {
    deferredPoolWaitCount--
  }
}

/**
 * @param {PoolWaitTransfer} transfer
 * @param {object} connection
 * @param {number} waitTime
 */
function deferPoolWaitTime (transfer, connection, waitTime) {
  const candidate = { transfer, waitTime }
  if (!deferredPoolWaitTimes.has(connection)) deferredPoolWaitCount++
  deferredPoolWaitTimes.set(connection, candidate)
}

/**
 * @param {PoolWaitTransfer} poolWaitTransfer
 * @param {ClusterAcquire | typeof poolQueryAcquire | undefined} acquire
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
function runConnectionCallback (
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
  if (acquire === undefined && !error && connection !== undefined) clearPoolWaitTime(connection)

  if (acquire === undefined || error || connection === undefined) {
    if (error && acquire !== undefined && acquire !== poolQueryAcquire) {
      if (acquire.key !== undefined) deferredClusterAcquires.set(acquire.key, acquire)

      const previous = currentPoolQueryAcquire
      currentPoolQueryAcquire = acquire
      try {
        return connectionFinishCh.runStores(ctx, callback, thisArg, ...args)
      } finally {
        currentPoolQueryAcquire = previous
      }
    }

    return connectionFinishCh.runStores(ctx, callback, thisArg, ...args)
  }

  if (acquire !== poolQueryAcquire) {
    if (acquire.key !== undefined) deferredClusterAcquires.delete(acquire.key)
    acquire.key = undefined
  }

  const waitTime = acquireWait(start)
  const index = startPoolWaitTransfer(poolWaitTransfer, connection, waitTime)

  try {
    return connectionFinishCh.runStores(ctx, callback, thisArg, ...args)
  } finally {
    finishPoolWaitTransfer(poolWaitTransfer, connection, waitTime, index)
  }
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
  finishPoolWaitTransfer,
  runDeferredPoolQueryAcquire,
  startPoolWaitTransfer,
  takeDeferredPoolQueryAcquire,
  takePoolWaitTime,
  wrapPoolAcquireCarrier,
  wrapPoolClusterGetConnection,
  wrapPoolClusterMethod,
  wrapPoolClusterQueryMethod,
  wrapPoolGetConnection,
  wrapPoolQueryCarrier,
  wrapPoolQueryMethod,
}
