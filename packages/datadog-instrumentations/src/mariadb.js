'use strict'

const { performance } = require('node:perf_hooks')

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')
const {
  acquireWait,
  clearPoolWaitTime,
  isPoolQueryAcquire,
  runOutsidePoolQueryAcquire,
  runPoolAcquireError,
  runWithPoolWait,
  takePoolWaitTime,
  wrapPoolQueryMethod,
} = require('./helpers/pool-acquire')

const commandAddCh = channel('apm:mariadb:command:add')
const connectionStartCh = channel('apm:mariadb:connection:start')
const connectionFinishCh = channel('apm:mariadb:connection:finish')
const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')
const acquireStartCh = channel('apm:mariadb:pool:acquire:start')
const acquireFinishCh = channel('apm:mariadb:pool:acquire:finish')
const poolAcquireChannels = {
  connectionFinishCh,
  acquireStartCh,
  acquireFinishCh,
}
const wrappedPools = new WeakSet()

/**
 * @typedef {object} PoolAcquireTiming
 * @property {number} [poolAcquireStart]
 * @property {number} [poolAcquireStartedAt]
 * @property {number} [poolWaitTime]
 */

/** @typedef {{ length: number, [index: number]: unknown } & Iterable<unknown>} ArgumentsLike */

/** @type {PoolAcquireTiming|undefined} */
let currentPoolAcquireTiming
let explicitPoolAcquire = false

/**
 * Apply pipeline source write-back before starting a MariaDB v3 command.
 *
 * MariaDB resolves query completion through command `resolve` / `reject` callbacks, so the command wrapper remains
 * the lifecycle owner instead of treating `start()` as an async method.
 *
 * @param {Function} start Original command start method.
 * @param {unknown[]} args Command start arguments.
 * @param {{sql: unknown}} ctx Query lifecycle context.
 * @returns {unknown} Original command result.
 */
function runCommandStart (start, args, ctx) {
  this.sql = ctx.sql
  return start.apply(this, args)
}

function wrapCommandStart (start, ctx) {
  return shimmer.wrapFunction(start, start => function (...args) {
    if (!startCh.hasSubscribers) return start.apply(this, args)

    const poolWaitTime = takePoolWaitTime(args[0])
    if (poolWaitTime !== undefined) {
      ctx.poolWaitTime = poolWaitTime
    }

    const { reject, resolve } = this
    shimmer.wrap(this, 'resolve', function wrapResolve () {
      return function (...args) {
        return finishCh.runStores(ctx, resolve, this, ...args)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject () {
      return function (error) {
        ctx.error = error

        errorCh.publish(ctx)

        return finishCh.runStores(ctx, reject, this, ...arguments)
      }
    })

    return startCh.runStores(ctx, runCommandStart, this, start, args, ctx)
  })
}

function wrapCommand (Command) {
  return class extends Command {
    constructor (...args) {
      super(...args)

      if (!this.start) return

      const ctx = { sql: this.sql, conf: this.opts }

      commandAddCh.publish(ctx)

      this.start = wrapCommandStart(this.start, ctx)
    }
  }
}

/**
 * Apply pipeline source write-back before starting a MariaDB v2 query.
 *
 * @param {Function} query Original query method.
 * @param {ArgumentsLike} args Query arguments.
 * @param {{sql: unknown}} ctx Query lifecycle context.
 * @returns {unknown} Original query result.
 */
function runQuery (query, args, ctx) {
  args[0] = ctx.sql
  return query.apply(this, args)
}

function createWrapQuery (options) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const ctx = { sql, conf: options }

      return startCh.runStores(ctx, runQuery, this, query, arguments, ctx)
        .then(result => {
          ctx.result = result
          finishCh.publish(ctx)
          return result
        }, error => {
          ctx.error = error
          errorCh.publish(ctx)
          finishCh.publish(ctx)
          throw error
        })
    }
  }
}

function createWrapQueryCallback (options) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const cb = arguments[arguments.length - 1]
      const ctx = { sql, conf: options }
      const wrapper = (cb) => function (err) {
        if (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }

        return typeof cb === 'function'
          ? finishCh.runStores(ctx, cb, this, ...arguments)
          : finishCh.publish(ctx)
      }

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapCallback(cb, wrapper)
      } else {
        arguments.length += 1
        arguments[arguments.length - 1] = wrapper()
      }

      return startCh.runStores(ctx, runQuery, this, query, arguments, ctx)
    }
  }
}

function wrapConnection (promiseMethod, Connection) {
  return function (options) {
    Connection.apply(this, arguments)

    shimmer.wrap(this, promiseMethod, createWrapQuery(options))
    shimmer.wrap(this, '_queryCallback', createWrapQueryCallback(options))
  }
}

function wrapPoolBase (PoolBase) {
  return function (options, processTask, createConnectionPool, pingPromise) {
    arguments[1] = wrapPoolMethod(processTask)
    arguments[2] = wrapPoolMethod(createConnectionPool)

    PoolBase.apply(this, arguments)

    shimmer.wrap(this, 'query', createWrapQuery(options.connOptions))
  }
}

// It's not possible to prevent connection pools from leaking across queries,
// so instead we just skip instrumentation completely to avoid memory leaks
// and/or orphan spans.
function wrapPoolMethod (createConnection) {
  return function (...args) {
    return skipCh.runStores({}, createConnection, this, ...args)
  }
}

/**
 * @param {Function} getConnection
 * @returns {Function}
 */
function wrapExplicitPoolGetConnection (getConnection) {
  return function wrappedExplicitPoolGetConnection () {
    if (!connectionStartCh.hasSubscribers) {
      return getConnection.apply(this, arguments)
    }

    const previous = explicitPoolAcquire
    explicitPoolAcquire = true
    try {
      return runOutsidePoolQueryAcquire(getConnection, this, arguments)
    } finally {
      explicitPoolAcquire = previous
    }
  }
}

/**
 * @param {Function} method
 * @returns {Function}
 */
function wrapPoolQuery (method) {
  return wrapPoolQueryMethod(method, connectionStartCh)
}

/**
 * @param {Function} Pool
 * @returns {boolean}
 */
function claimPoolWrap (Pool) {
  if (wrappedPools.has(Pool)) return false
  wrappedPools.add(Pool)
  return true
}

/**
 * @param {Function} Pool
 * @returns {Function}
 */
function wrapPublicPool (Pool) {
  if (!claimPoolWrap(Pool)) return Pool

  shimmer.wrap(Pool.prototype, 'getConnection', wrapExplicitPoolGetConnection)
  shimmer.wrap(Pool.prototype, 'query', wrapPoolQuery)
  shimmer.wrap(Pool.prototype, 'execute', wrapPoolQuery)
  return Pool
}

/**
 * @param {Function} Pool
 * @returns {Function}
 */
function wrapInternalPool (Pool) {
  if (!claimPoolWrap(Pool)) return Pool

  // The idle callback must be replaced before validation and observed before the method returns,
  // which cannot be expressed by Orchestrion's subscriber lifecycle.
  shimmer.wrap(Pool.prototype, '_acquireIdleConnection', wrapPoolAcquireIdleMethod)
  shimmer.wrap(Pool.prototype, 'getConnection', wrapPoolGetConnectionMethod)
  shimmer.wrap(Pool.prototype, '_createPoolConnection', wrapPoolMethod)
  return Pool
}

/**
 * @param {Record<string, unknown>} acquireCtx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {ArgumentsLike} args
 * @returns {unknown}
 */
function finishExplicitPoolAcquire (acquireCtx, callback, thisArg, args) {
  acquireFinishCh.publish(acquireCtx)
  return callback.apply(thisArg, args)
}

/**
 * @param {PoolAcquireTiming} timing
 */
function startPoolAcquireTiming (timing) {
  const start = performance.now()
  timing.poolAcquireStart = start
  timing.poolAcquireStartedAt ??= start
}

/**
 * @param {PoolAcquireTiming} timing
 * @returns {number}
 */
function finishPoolAcquireTiming (timing) {
  const poolWaitTime = (timing.poolWaitTime ?? 0) + acquireWait(timing.poolAcquireStart)
  timing.poolAcquireStart = undefined
  timing.poolWaitTime = poolWaitTime
  return poolWaitTime
}

/**
 * @param {Function} acquireIdleConnection
 * @returns {Function}
 */
function wrapPoolAcquireIdleMethod (acquireIdleConnection) {
  return function wrappedAcquireIdleConnection (callback) {
    const timing = currentPoolAcquireTiming
    if (timing === undefined) {
      return acquireIdleConnection.apply(this, arguments)
    }
    currentPoolAcquireTiming = undefined

    let completed = false
    let synchronous = true

    /**
     * @param {unknown} error
     * @returns {unknown}
     */
    arguments[0] = function wrappedCallback (error) {
      completed = true
      if (error) {
        if (synchronous) {
          startPoolAcquireTiming(timing)
        }
      } else if (synchronous) {
        timing.poolWaitTime = 0
      } else {
        finishPoolAcquireTiming(timing)
      }
      return callback.apply(this, arguments)
    }

    const result = acquireIdleConnection.apply(this, arguments)
    synchronous = false
    if (!completed) {
      startPoolAcquireTiming(timing)
    }
    return result
  }
}

/**
 * @param {Function} getConnection
 * @returns {Function}
 */
function wrapPoolGetConnectionMethod (getConnection) {
  const poolWaitTransfer = { deferred: false }

  return function wrappedGetConnection (cmdParam, callback) {
    if (!connectionStartCh.hasSubscribers) {
      return getConnection.apply(this, arguments)
    }

    const ctx = {}
    const poolQueryAcquire = isPoolQueryAcquire()
    const acquireCtx = !poolQueryAcquire && explicitPoolAcquire && acquireStartCh.hasSubscribers
      ? { conf: this.opts.connOptions }
      : undefined
    const pool = this

    if (acquireCtx !== undefined) {
      acquireStartCh.publish(acquireCtx)
    }

    /**
     * @param {unknown} error
     * @param {{ streamOut: object }|undefined} connection
     * @returns {unknown}
     */
    arguments[1] = function wrappedCallback (error, connection) {
      const poolWaitTime = poolQueryAcquire || acquireCtx !== undefined
        ? finishPoolAcquireTiming(ctx)
        : undefined

      if (poolQueryAcquire) {
        if (error) {
          return runPoolAcquireError(
            ctx.poolAcquireStartedAt,
            error,
            { conf: pool.opts.connOptions },
            poolAcquireChannels,
            ctx,
            callback,
            this,
            arguments,
            poolWaitTime
          )
        }

        return runWithPoolWait(
          poolWaitTransfer,
          connection.streamOut,
          poolWaitTime,
          connectionFinishCh,
          ctx,
          callback,
          this,
          arguments
        )
      }

      if (acquireCtx !== undefined) {
        if (!error && connection !== undefined) {
          clearPoolWaitTime(connection.streamOut)
        }
        acquireCtx.error = error
        acquireCtx.poolWaitTime = poolWaitTime
        return connectionFinishCh.runStores(
          ctx,
          finishExplicitPoolAcquire,
          undefined,
          acquireCtx,
          callback,
          this,
          arguments
        )
      }
      return connectionFinishCh.runStores(ctx, callback, this, ...arguments)
    }

    connectionStartCh.publish(ctx)

    if (!poolQueryAcquire && acquireCtx === undefined) {
      return getConnection.apply(pool, arguments)
    }

    const previousTiming = currentPoolAcquireTiming
    const previousExplicitPoolAcquire = explicitPoolAcquire
    currentPoolAcquireTiming = ctx
    if (previousExplicitPoolAcquire) explicitPoolAcquire = false
    try {
      return poolQueryAcquire
        ? runOutsidePoolQueryAcquire(getConnection, pool, arguments)
        : getConnection.apply(pool, arguments)
    } finally {
      currentPoolAcquireTiming = previousTiming
      if (previousExplicitPoolAcquire) explicitPoolAcquire = true
    }
  }
}

const name = 'mariadb'

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3'], patchDefault: true }, wrapCommand)
addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3'], patchDefault: true }, wrapCommand)

// mariadb 3.4.1 switched its internal getConnection from promises to callbacks. That exposes synchronous
// recent-idle reuse without a clock read while still letting us time validation and queueing.
// The same release renamed _createConnection to _createPoolConnection.
addHook({ name, file: 'lib/pool.js', versions: ['>=3.4.1'], patchDefault: true }, wrapInternalPool)

// Orchestrion completion follows the returned Promise, but operation classification must end as
// soon as the facade calls its private internal pool, so these methods need a synchronous bracket.
addHook({ name, file: 'lib/pool-promise.js', versions: ['>=3.4.1'], patchDefault: true }, wrapPublicPool)
addHook({ name, file: 'lib/pool-callback.js', versions: ['>=3.4.1'], patchDefault: true }, wrapPublicPool)

addHook({ name, file: 'lib/pool.js', versions: ['>=3 <3.4.1'], patchDefault: true }, (Pool) => {
  shimmer.wrap(Pool.prototype, '_createConnection', wrapPoolMethod)

  return Pool
})

addHook({ name, file: 'lib/connection.js', versions: ['>=2.5.2 <3'] }, (Connection) => {
  return shimmer.wrapFunction(Connection, wrapConnection.bind(null, '_queryPromise'))
})

addHook({ name, file: 'lib/connection.js', versions: ['>=2.0.4 <=2.5.1'] }, (Connection) => {
  return shimmer.wrapFunction(Connection, wrapConnection.bind(null, 'query'))
})

addHook({ name, file: 'lib/pool-base.js', versions: ['>=2.0.4 <3'] }, (PoolBase) => {
  return shimmer.wrapFunction(PoolBase, wrapPoolBase)
})
