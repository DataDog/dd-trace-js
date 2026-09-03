'use strict'

const { errorMonitor } = require('node:events')
const { performance } = require('node:perf_hooks')

/**
 * @typedef {import('node:diagnostics_channel').Channel} Channel
 * @typedef {{ length: number, [index: number]: unknown } & Iterable<unknown>} ArgumentsLike
 * @typedef {{
 *   acquired?: boolean,
 *   callback?: Function,
 *   conf?: Record<string, unknown>,
 *   errorReported?: boolean,
 *   key?: object,
 *   observesError?: boolean,
 *   start?: number
 * }} ClusterAcquire
 * @typedef {{ _freeConnections?: { length: number } }} Pool
 * @typedef {{ deferred: boolean }} PoolWaitTransfer
 * @typedef {{ transfer: PoolWaitTransfer, waitTime: number }} DeferredPoolWait
 * @typedef {{ pending: boolean, pool: object }} DeferredPoolQueryAcquire
 * @typedef {'mariadb'|'mysql'|'mysql2'|'pg'} DatabaseDriver
 * @typedef {{ connection?: object, owner: object, pending: boolean }} PromisePoolQueryAcquire
 * @typedef {{ waitTime?: number }} PoolAcquireCapture
 * @typedef {{
 *   connectionFinishCh: Channel,
 *   acquireStartCh: Channel,
 *   acquireFinishCh: Channel
 * }} AcquireErrorChannels
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

/** @type {import('node:async_hooks').AsyncLocalStorage<PromisePoolQueryAcquire>|undefined} */
let promisePoolQueryAcquireStorage

/** @type {PoolAcquireCapture|undefined} */
let currentPoolAcquireCapture

/** @type {WeakMap<object, ClusterAcquire>} */
const deferredClusterAcquires = new WeakMap()

// Keep synchronous wait handoff allocation-free; a delayed consumer promotes only its pool wrapper.
const poolWaitConnections = []
const poolWaitTimes = []

/** @type {WeakMap<object, DeferredPoolWait>} */
const deferredPoolWaitTimes = new WeakMap()
let deferredPoolWaitCount = 0

/** @type {Record<string, { acquireStartCh: Channel, acquireFinishCh: Channel }>} */
const promisePoolAcquireChannels = {}

/** @type {WeakMap<object, Record<string, unknown>>} */
const promisePoolConnectionConfigs = new WeakMap()

const deferredPromisePoolWaitTransfer = { deferred: true }

/**
 * Mark a promise-returning ORM operation as the owner of its next pool acquisition.
 *
 * @param {Function} method
 * @param {(receiver: object, args: ArgumentsLike) => object|undefined} resolveOwner
 * @param {(receiver: object, args: ArgumentsLike) => DatabaseDriver|undefined} resolveDriver
 * @returns {Function}
 */
function wrapPromisePoolQueryMethod (method, resolveOwner, resolveDriver) {
  return function () {
    const driver = resolveDriver(this, arguments)
    if (driver === undefined || !getPromisePoolAcquireChannels(driver).acquireStartCh.hasSubscribers) {
      return method.apply(this, arguments)
    }

    const owner = resolveOwner(this, arguments)
    if (owner === undefined) return method.apply(this, arguments)

    const storage = getPromisePoolQueryAcquireStorage()
    return storage.run({ owner, pending: true }, () => method.apply(this, arguments))
  }
}

/**
 * Instrument a promise-returning ORM pool acquisition using the underlying driver contract.
 *
 * @param {Function} method
 * @param {(receiver: object, args: ArgumentsLike) => DatabaseDriver|undefined} resolveDriver
 * @param {(receiver: object, args: ArgumentsLike) => Record<string, unknown>} resolveConfig
 * @param {(receiver: object, args: ArgumentsLike) => boolean} hasIdleConnection
 * @returns {Function}
 */
function wrapPromisePoolAcquire (method, resolveDriver, resolveConfig, hasIdleConnection) {
  return function () {
    const driver = resolveDriver(this, arguments)
    if (driver === undefined) return method.apply(this, arguments)

    const channels = getPromisePoolAcquireChannels(driver)
    if (!channels.acquireStartCh.hasSubscribers) return method.apply(this, arguments)

    const queryAcquire = promisePoolQueryAcquireStorage?.getStore()
    const internal = queryAcquire?.owner === this && queryAcquire.pending
    if (internal) queryAcquire.pending = false
    const start = hasIdleConnection(this, arguments) ? undefined : performance.now()
    const capture = {}
    let ctx

    if (!internal) {
      ctx = createPromisePoolAcquireContext(driver, resolveConfig(this, arguments))
      channels.acquireStartCh.publish(ctx)
    }

    let result
    try {
      result = runWithPoolAcquireCapture(capture, method, this, arguments)
    } catch (error) {
      if (internal) queryAcquire.pending = true
      finishPromisePoolAcquire(driver, channels, ctx, start, capture, error, resolveConfig(this, arguments))
      throw error
    }

    return result.then(connection => {
      const waitTime = capture.waitTime ?? acquireWait(start)
      if (internal) {
        queryAcquire.connection = connection
        setPoolWaitTime(connection, waitTime)
      } else {
        finishPromisePoolAcquireContext(driver, channels, ctx, connection, waitTime)
      }
      return connection
    }, error => {
      if (internal) queryAcquire.pending = true
      finishPromisePoolAcquire(driver, channels, ctx, start, capture, error, resolveConfig(this, arguments))
      throw error
    })
  }
}

/**
 * Clear an acquisition that was never consumed by a driver query.
 *
 * @param {Function} method
 * @returns {Function}
 */
function wrapPoolRelease (method) {
  return function (connection) {
    const queryAcquire = promisePoolQueryAcquireStorage?.getStore()
    if (queryAcquire?.owner === this && queryAcquire.connection === connection) {
      queryAcquire.connection = undefined
      queryAcquire.pending = true
    }
    if (connection !== undefined) clearPoolWaitTime(connection)
    return method.apply(this, arguments)
  }
}

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
 * @param {AcquireChannels} channels
 * @returns {Function}
 */
function wrapPoolClusterQueryMethod (method, channels) {
  return function () {
    if (!channels.connectionStartCh.hasSubscribers) return method.apply(this, arguments)

    const key = arguments[0]
    const acquire = takeClusterAcquire(key) ?? {}
    const result = runWithPoolQueryAcquire(acquire, method, this, arguments)

    if (isWeakKey(result)) acquire.key = result
    if (!acquire.observesError) {
      const callback = result?._callback
      if (typeof callback === 'function') {
        acquire.observesError = true
        result._callback = wrapClusterQueryCallback(callback, acquire, channels)
      } else if (typeof result?.once === 'function') {
        acquire.observesError = true
        result.once(errorMonitor, error => reportClusterAcquireError(acquire, error, channels))
      }
    }
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
 * @param {AcquireChannels} channels
 * @returns {Function}
 */
function wrapPoolClusterGetConnection (method, channels) {
  return function (callback) {
    if (!channels.connectionStartCh.hasSubscribers) return method.apply(this, arguments)

    const previous = currentPoolQueryAcquire
    const acquire = isClusterAcquire(previous) && previous.key === undefined
      ? previous
      : takeClusterAcquire(callback)

    if (acquire === undefined && previous === undefined) return method.apply(this, arguments)
    if (acquire !== undefined) {
      if (acquire.callback === undefined) {
        acquire.callback = wrapClusterAcquireCallback(callback, acquire, channels)
      }
      arguments[0] = acquire.callback
      acquire.key = acquire.callback
    }

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

    const pool = this
    const ctx = {}
    const capture = currentPoolAcquireCapture
    if (capture !== undefined) {
      const start = acquireStart(pool)

      arguments[0] = function () {
        capture.waitTime = acquireWait(start)
        return connectionFinishCh.runStores(ctx, callback, this, ...arguments)
      }
      if (queuedCallbacks !== undefined) queuedCallbacks.add(arguments[0])

      connectionStartCh.publish(ctx)
      try {
        return getConnection.apply(pool, arguments)
      } catch (error) {
        capture.waitTime = acquireWait(start)
        throw error
      }
    }

    const acquire = currentPoolQueryAcquire
    const acquireCtx = acquire === undefined && acquireStartCh.hasSubscribers
      ? { conf: pool.config.connectionConfig }
      : undefined
    const start = acquireStart(pool, acquire)

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
        pool,
        channels,
        ctx,
        callback,
        this,
        arguments
      )
    }
    if (queuedCallbacks !== undefined) queuedCallbacks.add(wrappedCallback)
    arguments[0] = wrappedCallback

    connectionStartCh.publish(ctx)
    if (acquire !== undefined) {
      return runWithPoolQueryAcquire(undefined, getConnection, pool, arguments)
    }
    if (acquireCtx !== undefined) {
      return getConnectionForAcquire(getConnection, pool, arguments, acquireCtx, start, acquireFinishCh)
    }
    return getConnection.apply(pool, arguments)
  }
}

/**
 * @param {Function} getConnection
 * @param {object} pool
 * @param {ArgumentsLike} args
 * @param {Record<string, unknown>} acquireCtx
 * @param {number|undefined} start
 * @param {Channel} acquireFinishCh
 * @returns {unknown}
 */
function getConnectionForAcquire (getConnection, pool, args, acquireCtx, start, acquireFinishCh) {
  try {
    return getConnection.apply(pool, args)
  } catch (error) {
    if (acquireCtx.poolWaitTime === undefined) {
      acquireCtx.error = error
      acquireCtx.poolWaitTime = acquireWait(start)
      acquireFinishCh.publish(acquireCtx)
    }
    throw error
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
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function runOutsidePoolQueryAcquire (method, receiver, args) {
  return runWithPoolQueryAcquire(undefined, method, receiver, args)
}

/**
 * @param {ClusterAcquire | typeof poolQueryAcquire | undefined} acquire
 * @param {Function} method
 * @param {unknown} receiver
 * @param {ArgumentsLike} args
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
 * @returns {import('node:async_hooks').AsyncLocalStorage<PromisePoolQueryAcquire>}
 */
function getPromisePoolQueryAcquireStorage () {
  if (promisePoolQueryAcquireStorage === undefined) {
    const { AsyncLocalStorage } = require('node:async_hooks')
    promisePoolQueryAcquireStorage = new AsyncLocalStorage()
  }
  return promisePoolQueryAcquireStorage
}

/**
 * @param {DatabaseDriver} driver
 * @returns {{ acquireStartCh: Channel, acquireFinishCh: Channel }}
 */
function getPromisePoolAcquireChannels (driver) {
  let channels = promisePoolAcquireChannels[driver]
  if (channels === undefined) {
    const { channel } = require('./instrument')
    channels = {
      acquireStartCh: channel(`apm:${driver}:pool:acquire:start`),
      acquireFinishCh: channel(`apm:${driver}:pool:acquire:finish`),
    }
    promisePoolAcquireChannels[driver] = channels
  }
  return channels
}

/**
 * @param {DatabaseDriver} driver
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
function createPromisePoolAcquireContext (driver, config) {
  return driver === 'pg' ? { poolOptions: config } : { conf: config }
}

/**
 * @param {DatabaseDriver} driver
 * @param {{ acquireFinishCh: Channel }} channels
 * @param {Record<string, unknown>|undefined} ctx
 * @param {{
 *   config?: Record<string, unknown>,
 *   connectionParameters?: Record<string, unknown>,
 *   opts?: Record<string, unknown>
 * }} connection
 * @param {number} waitTime
 */
function finishPromisePoolAcquireContext (driver, channels, ctx, connection, waitTime) {
  ctx.poolWaitTime = waitTime
  if (driver === 'pg') ctx.params = connection.connectionParameters
  else if (driver === 'mariadb') ctx.connectionConfig = promisePoolConnectionConfigs.get(connection)
  else ctx.connectionConfig = connection.config
  channels.acquireFinishCh.publish(ctx)
}

/**
 * @param {object} connection
 * @param {Record<string, unknown>} config
 */
function setPromisePoolConnectionConfig (connection, config) {
  promisePoolConnectionConfigs.set(connection, config)
}

/**
 * @param {DatabaseDriver} driver
 * @param {{ acquireStartCh: Channel, acquireFinishCh: Channel }} channels
 * @param {Record<string, unknown>|undefined} ctx
 * @param {number|undefined} start
 * @param {PoolAcquireCapture} capture
 * @param {unknown} error
 * @param {Record<string, unknown>} config
 */
function finishPromisePoolAcquire (driver, channels, ctx, start, capture, error, config) {
  const waitTime = capture.waitTime ?? acquireWait(start)
  if (ctx === undefined) {
    ctx = createPromisePoolAcquireContext(driver, config)
    if (start !== undefined) ctx.startTime = performance.timeOrigin + start
    channels.acquireStartCh.publish(ctx)
  }
  ctx.error = error
  ctx.poolWaitTime = waitTime
  channels.acquireFinishCh.publish(ctx)
}

/**
 * @param {PoolAcquireCapture} capture
 * @param {Function} method
 * @param {object} receiver
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function runWithPoolAcquireCapture (capture, method, receiver, args) {
  const previous = currentPoolAcquireCapture
  currentPoolAcquireCapture = capture
  try {
    return method.apply(receiver, args)
  } finally {
    currentPoolAcquireCapture = previous
  }
}

/**
 * @returns {PoolAcquireCapture|undefined}
 */
function getPoolAcquireCapture () {
  return currentPoolAcquireCapture
}

/**
 * @param {PoolAcquireCapture} capture
 * @param {number} waitTime
 */
function setPoolAcquireCaptureWaitTime (capture, waitTime) {
  capture.waitTime = waitTime
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
 * @param {ArgumentsLike} args
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
 * @param {object} connection
 * @param {number} waitTime
 */
function setPoolWaitTime (connection, waitTime) {
  clearPoolWaitTime(connection)
  deferPoolWaitTime(deferredPromisePoolWaitTransfer, connection, waitTime)
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
 * @param {{ config: { connectionConfig: Record<string, unknown> } }} pool
 * @param {AcquireChannels} channels
 * @param {object} ctx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function runPoolQueryConnectionCallback (
  poolWaitTransfer,
  acquire,
  start,
  error,
  connection,
  pool,
  channels,
  ctx,
  callback,
  thisArg,
  args
) {
  if (error || connection === undefined) {
    const conf = pool.config.connectionConfig
    if (error && isClusterAcquire(acquire)) {
      acquire.conf = conf
      if (acquire.key !== undefined) deferredClusterAcquires.set(acquire.key, acquire)
      return channels.connectionFinishCh.runStores(ctx, callback, thisArg, ...args)
    }
    if (error && channels.acquireStartCh.hasSubscribers) {
      return runPoolAcquireError(
        start,
        error,
        { conf },
        channels,
        ctx,
        callback,
        thisArg,
        args
      )
    }
    return channels.connectionFinishCh.runStores(ctx, callback, thisArg, ...args)
  }

  if (isClusterAcquire(acquire)) {
    if (acquire.key !== undefined) deferredClusterAcquires.delete(acquire.key)
    acquire.acquired = true
    acquire.key = undefined
  }

  return runWithPoolWait(
    poolWaitTransfer,
    connection,
    acquireWait(start),
    channels.connectionFinishCh,
    ctx,
    callback,
    thisArg,
    args
  )
}

/**
 * @param {number|undefined} start
 * @param {unknown} error
 * @param {Record<string, unknown>} acquireCtx
 * @param {AcquireErrorChannels} channels
 * @param {number} [poolWaitTime]
 */
function reportPoolAcquireError (start, error, acquireCtx, channels, poolWaitTime) {
  acquireCtx.error = error
  acquireCtx.poolWaitTime = poolWaitTime ?? acquireWait(start)
  if (start !== undefined) acquireCtx.startTime = performance.timeOrigin + start
  channels.acquireStartCh.publish(acquireCtx)
  channels.acquireFinishCh.publish(acquireCtx)
}

/**
 * @param {number|undefined} start
 * @param {unknown} error
 * @param {Record<string, unknown>} acquireCtx
 * @param {AcquireErrorChannels} channels
 * @param {object} connectionCtx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {ArgumentsLike} args
 * @param {number} [poolWaitTime]
 * @returns {unknown}
 */
function runPoolAcquireError (
  start, error, acquireCtx, channels, connectionCtx, callback, thisArg, args, poolWaitTime
) {
  return channels.connectionFinishCh.runStores(connectionCtx, () => {
    reportPoolAcquireError(start, error, acquireCtx, channels, poolWaitTime)
    return callback.apply(thisArg, args)
  })
}

/**
 * @param {Function} callback
 * @param {ClusterAcquire} acquire
 * @param {AcquireChannels} channels
 * @returns {Function}
 */
function wrapClusterAcquireCallback (callback, acquire, channels) {
  return function (error) {
    if (error) reportClusterAcquireError(acquire, error, channels)
    if (currentPoolQueryAcquire !== undefined) {
      return runWithPoolQueryAcquire(undefined, callback, this, arguments)
    }
    return callback.apply(this, arguments)
  }
}

/**
 * @param {Function} callback
 * @param {ClusterAcquire} acquire
 * @param {AcquireChannels} channels
 * @returns {Function}
 */
function wrapClusterQueryCallback (callback, acquire, channels) {
  return function (error) {
    if (error) reportClusterAcquireError(acquire, error, channels)
    return callback.apply(this, arguments)
  }
}

/**
 * @param {ClusterAcquire} acquire
 * @param {unknown} error
 * @param {AcquireChannels} channels
 */
function reportClusterAcquireError (acquire, error, channels) {
  if (acquire.acquired || acquire.errorReported || !channels.acquireStartCh.hasSubscribers) return
  acquire.errorReported = true
  reportPoolAcquireError(acquire.start, error, { conf: acquire.conf ?? {} }, channels)
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
  acquireWait,
  clearPoolWaitTime,
  dispatchesAcquireSynchronously,
  getPoolAcquireCapture,
  isPoolQueryAcquire,
  reportPoolAcquireError,
  runOutsidePoolQueryAcquire,
  runPoolAcquireError,
  runWithPoolWait,
  setPoolAcquireCaptureWaitTime,
  setPoolWaitTime,
  setPromisePoolConnectionConfig,
  takePoolWaitTime,
  wrapPoolAcquireCarrier,
  wrapPoolClusterGetConnection,
  wrapPoolClusterMethod,
  wrapPoolClusterQueryMethod,
  wrapPoolGetConnection,
  wrapPoolQueryMethod,
  wrapPoolRelease,
  wrapPromisePoolAcquire,
  wrapPromisePoolQueryMethod,
}
