'use strict'

const { errorMonitor } = require('node:events')
const { performance } = require('node:perf_hooks')

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')
const {
  clearPoolWaitTime,
  dispatchesAcquireSynchronously,
  getPoolAcquireCapture,
  isPoolQueryAcquire,
  runOutsidePoolQueryAcquire,
  runPoolAcquireError,
  runWithPoolWait,
  setPoolAcquireCaptureWaitTime,
  takePoolWaitTime,
  wrapPoolAcquireCarrier,
  wrapPoolQueryMethod,
} = require('./helpers/pool-acquire')

const startCh = channel('apm:pg:query:start')
const finishCh = channel('apm:pg:query:finish')
const errorCh = channel('apm:pg:query:error')

const startPoolQueryCh = channel('datadog:pg:pool:query:start')
const finishPoolQueryCh = channel('datadog:pg:pool:query:finish')

const poolConnectStartCh = channel('apm:pg:pool:connect:start')
const poolConnectFinishCh = channel('apm:pg:pool:connect:finish')

const poolAcquireStartCh = channel('apm:pg:pool:acquire:start')
const poolAcquireFinishCh = channel('apm:pg:pool:acquire:finish')
const poolAcquireChannels = {
  connectionFinishCh: poolConnectFinishCh,
  acquireStartCh: poolAcquireStartCh,
  acquireFinishCh: poolAcquireFinishCh,
}

// Drivers like pg-promise reuse the same prepared-statement query object across executions; cache
// the un-injected `text` so the wrap doesn't capture a previous DBM injection as the new original.
const originalTextCache = new WeakMap()

addHook({ name: 'pg', versions: ['>=8.0.3'], file: 'lib/native/client.js' }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

addHook({ name: 'pg', versions: ['>=8.0.3'], file: 'lib/client.js' }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

addHook({ name: 'pg', versions: ['>=8.0.3'] }, pg => {
  const poolWaitTransfer = { deferred: false }
  const deferredPoolAcquire = !dispatchesAcquireSynchronously(
    pg.Pool.prototype.query,
    Object.assign(Object.create(pg.Pool.prototype), { Promise }),
    'connect',
    ['SELECT 1', () => {}]
  )

  // pg defers a busy pool's connect callback and runs it in the releasing query's async context;
  // capture the caller's context and restore it around the callback so spans attach to the caller.
  shimmer.wrap(pg.Pool.prototype, 'connect', connect => {
    /**
     * @param {Function|undefined} callback
     * @returns {unknown}
     */
    const wrappedConnect = function (callback) {
      const capture = getPoolAcquireCapture()
      if (capture !== undefined && typeof callback !== 'function') {
        const start = acquireStart(this)
        const result = connect.apply(this, arguments)
        return result.then(client => {
          setPoolAcquireCaptureWaitTime(capture, acquireWait(start))
          return client
        }, error => {
          setPoolAcquireCaptureWaitTime(capture, acquireWait(start))
          throw error
        })
      }

      // Pool.query always supplies a callback, so a missing callback is an explicit acquire.
      if (typeof callback !== 'function') {
        if (!poolAcquireStartCh.hasSubscribers) {
          return connect.apply(this, arguments)
        }

        const start = acquireStart(this)
        const acquireCtx = { poolOptions: this.options }
        poolAcquireStartCh.publish(acquireCtx)

        return connectForAcquire(connect, this, arguments, acquireCtx, start).then(client => {
          clearPoolWaitTime(client)
          acquireCtx.params = client.connectionParameters
          finishAcquire(acquireCtx, start)
          return client
        }, error => {
          acquireCtx.error = error
          finishAcquire(acquireCtx, start)
          throw error
        })
      }

      if (!poolConnectStartCh.hasSubscribers) {
        return connect.apply(this, arguments)
      }

      const ctx = {}
      const poolOptions = this.options
      const start = acquireStart(this)
      const poolQueryAcquire = isPoolQueryAcquire()
      let acquireCtx

      if (poolQueryAcquire) {
        arguments[0] = function (...args) {
          const client = args[1]
          if (client !== undefined) {
            const waitTime = acquireWait(start)
            return runWithPoolWait(
              poolWaitTransfer,
              client,
              waitTime,
              poolConnectFinishCh,
              ctx,
              callback,
              this,
              args
            )
          }
          if (args[0] && poolAcquireStartCh.hasSubscribers) {
            return runPoolAcquireError(
              start,
              args[0],
              { poolOptions },
              poolAcquireChannels,
              ctx,
              callback,
              this,
              args
            )
          }
          return poolConnectFinishCh.runStores(ctx, callback, this, ...args)
        }
      } else {
        acquireCtx = { poolOptions: this.options }
        poolAcquireStartCh.publish(acquireCtx)

        arguments[0] = function (...args) {
          const client = args[1]
          acquireCtx.error = args[0]
          // A failed acquire has no client, so keep the parameters `connectForAcquire` snapshotted.
          if (client !== undefined) {
            clearPoolWaitTime(client)
            acquireCtx.params = client.connectionParameters
          }
          finishAcquire(acquireCtx, start)
          return poolConnectFinishCh.runStores(ctx, callback, this, ...args)
        }
      }

      poolConnectStartCh.publish(ctx)

      if (acquireCtx === undefined) return runOutsidePoolQueryAcquire(connect, this, arguments)

      return connectForAcquire(connect, this, arguments, acquireCtx, start)
    }

    return wrapPoolAcquireCarrier(
      wrappedConnect,
      connect,
      poolConnectStartCh,
      deferredPoolAcquire
    )
  })
  shimmer.wrap(pg.Pool.prototype, 'query', query => wrapPoolQuery(
    wrapPoolQueryMethod(query, poolConnectStartCh, deferredPoolAcquire)
  ))
  return pg
})

function wrapQuery (query) {
  return function (...args) {
    if (!startCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const processId = this.processID

    const pgQuery = args[0] !== null && typeof args[0] === 'object'
      ? args[0]
      : { text: args[0] }

    const textPropObj = pgQuery.cursor ?? pgQuery
    const stream = typeof textPropObj.read === 'function'

    let originalText = originalTextCache.get(textPropObj)
    if (originalText === undefined) {
      originalText = textPropObj.text
      originalTextCache.set(textPropObj, originalText)
    }

    const abortController = new AbortController()
    const ctx = {
      params: this.connectionParameters,
      query: textPropObj,
      originalText,
      processId,
      abortController,
      stream,
    }

    const waitTime = takePoolWaitTime(this)
    if (waitTime !== undefined) {
      ctx.poolWaitTime = waitTime
    }

    const submittable = typeof pgQuery.submit === 'function'

    return startCh.runStores(ctx, () => {
      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')

        // Based on: https://github.com/brianc/node-postgres/blob/54eb0fa216aaccd727765641e7d1cf5da2bc483d/packages/pg/lib/client.js#L510
        const callback = args.at(-1)

        finishQuery(ctx, error)

        if (submittable) {
          if (!pgQuery.callback && typeof callback === 'function') {
            pgQuery.callback = callback
          }

          if (pgQuery.callback) {
            pgQuery.callback(error)
          } else {
            process.nextTick(() => {
              pgQuery.emit('error', error)
            })
          }

          return pgQuery
        }

        if (typeof callback === 'function') {
          callback(error)

          return
        }

        return Promise.reject(error)
      }

      const injected = ctx.injected
      if (injected !== undefined) {
        // Skip the per-read getter trampoline when `text` is a configurable, writable data
        // property (the pg / pg-cursor common shape). Accessor descriptors and read-only data
        // still go through `defineProperty(get)` so `get text ()` query objects keep working.
        const textProp = Object.getOwnPropertyDescriptor(textPropObj, 'text')
        if (textProp?.configurable === true && textProp.writable === true) {
          textPropObj.text = injected
        } else if (textProp === undefined || textProp.configurable === true) {
          Object.defineProperty(textPropObj, 'text', {
            configurable: true,
            get () { return injected },
          })
        }
      }

      args[0] = pgQuery

      if (submittable) {
        return submitQuery(this, query, args, pgQuery, ctx)
      }

      const [, values, callback = values] = args

      // pg can call the callback before `client.query` returns, such as on query timeout, so it is wrapped up front.
      // A child of the config carries it, as older pg versions write the callback onto the config they are given.
      const queryCallback = typeof callback === 'function' ? callback : pgQuery.callback
      if (typeof queryCallback === 'function') {
        const queryValues = typeof values === 'function' ? undefined : values
        return query.call(this, { __proto__: pgQuery, callback: wrapCallback(ctx, queryCallback) }, queryValues)
      }

      const retval = query.apply(this, args)

      // Without a callback, pg resolves the promise it returns instead.
      if (typeof retval?.then === 'function') {
        retval.then(result => finishQuery(ctx, null, result), error => finishQuery(ctx, error))
      }

      return retval
    })
  }
}

/**
 * @typedef {{ query: object, error?: unknown, result?: unknown[] }} QueryContext
 * @typedef {{ rows?: unknown[] }} QueryResult
 * @typedef {(error: unknown, result?: QueryResult) => unknown} QueryCallback
 * @typedef {import('node:events').EventEmitter & { callback?: QueryCallback }} SubmittableQuery
 */

/**
 * Submits a query object the caller created, such as a `pg.Query` or a pg-cursor.
 *
 * @param {object} client
 * @param {Function} query the original `client.query`
 * @param {unknown[]} args
 * @param {SubmittableQuery} pgQuery `args[0]`
 * @param {QueryContext} ctx
 * @returns {unknown}
 */
function submitQuery (client, query, args, pgQuery, ctx) {
  const callback = args[1]
  let callbackWrapped = false

  // pg keeps a callback already on the query, while pg-native prefers the one passed with it.
  if (typeof pgQuery.callback === 'function') {
    pgQuery.callback = wrapCallback(ctx, pgQuery.callback, pgQuery)
    callbackWrapped = true
  }
  if (typeof callback === 'function') {
    args[1] = wrapCallback(ctx, /** @type {QueryCallback} */ (callback), pgQuery)
    callbackWrapped = true
  }

  // Streams such as pg-cursor and pg-query-stream report through events instead.
  if (!callbackWrapped && typeof pgQuery.once === 'function') {
    pgQuery
      .once(errorMonitor, error => finishQuery(ctx, error))
      .once('end', result => finishQuery(ctx, null, result))
  }

  return query.apply(client, args)
}

/**
 * @param {QueryContext} ctx
 * @param {QueryCallback} callback
 * @param {SubmittableQuery} [pgQuery] query object the caller may submit again
 * @returns {QueryCallback}
 */
function wrapCallback (ctx, callback, pgQuery) {
  const wrapped = function (error, result) {
    // pg leaves the callback on the query object. Give the caller's own back for its next submission.
    if (pgQuery?.callback === wrapped) {
      pgQuery.callback = callback
    }

    finishQuery(ctx, error, result)
    return finishCh.runStores(ctx, callback, this, error, result)
  }
  return wrapped
}

/**
 * @param {QueryContext} ctx
 * @param {unknown} error
 * @param {QueryResult} [result]
 */
function finishQuery (ctx, error, result) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  ctx.result = result?.rows
  finishCh.publish(ctx)
}

const finish = (ctx) => {
  finishPoolQueryCh.publish(ctx)
}

/**
 * @typedef {{ database?: string, user?: string, host?: string, port?: number }} PoolConnectionParameters
 * @typedef {{ connectionParameters?: PoolConnectionParameters }} PoolClient
 * @typedef {{
 *   options?: PoolConnectionParameters,
 *   idleCount: number,
 *   waitingCount: number,
 *   _clients?: PoolClient[]
 * }} InstrumentedPool
 * @typedef {{
 *   poolOptions?: PoolConnectionParameters,
 *   params?: PoolConnectionParameters,
 *   error?: unknown,
 *   poolWaitTime?: number
 * }} AcquireContext
 * @typedef {{ length: number, [index: number]: unknown } & Iterable<unknown>} ArgumentsLike
 */

// pg drains its pending queue FIFO on the next tick, so an idle client is only ours when it
// outnumbers the requests already queued ahead of us. That handoff is not a wait on the pool.
/**
 * @param {InstrumentedPool} pool
 */
function acquireStart (pool) {
  return pool.idleCount > pool.waitingCount ? undefined : performance.now()
}

/**
 * @param {number | undefined} start
 */
function acquireWait (start) {
  return start === undefined ? 0 : performance.now() - start
}

/**
 * @param {InstrumentedPool} pool
 */
function latestPoolConnectionParameters (pool) {
  // pg-pool removes a failed client before invoking the acquire callback, so snapshot it while
  // connect is still pending.
  const clients = pool._clients
  return clients?.at(-1)?.connectionParameters
}

/**
 * @param {Function} connect
 * @param {InstrumentedPool} pool
 * @param {ArgumentsLike} args
 * @param {AcquireContext} acquireCtx
 * @param {number | undefined} start
 */
function connectForAcquire (connect, pool, args, acquireCtx, start) {
  let result
  try {
    result = connect.apply(pool, args)
  } catch (error) {
    // pg throws synchronously when it cannot even build a client, from a malformed connection
    // string or a caller-supplied `Client` constructor, so the span needs finishing here.
    acquireCtx.error = error
    finishAcquire(acquireCtx, start)
    throw error
  }

  acquireCtx.params = latestPoolConnectionParameters(pool)
  return result
}

/**
 * @param {AcquireContext} ctx
 * @param {number | undefined} start
 */
function finishAcquire (ctx, start) {
  ctx.poolWaitTime = acquireWait(start)
  poolAcquireFinishCh.publish(ctx)
}

function wrapPoolQuery (query) {
  return function (...args) {
    if (!startPoolQueryCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const pgQuery = args[0] !== null && typeof args[0] === 'object' ? args[0] : { text: args[0] }
    const abortController = new AbortController()

    const ctx = { query: pgQuery, abortController }

    return startPoolQueryCh.runStores(ctx, () => {
      const cb = args.at(-1)

      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')
        finish(ctx)

        if (typeof cb === 'function') {
          cb(error)

          return
        }
        return Promise.reject(error)
      }

      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapCallback(cb, cb => function (...args) {
          finish(ctx)
          return cb.apply(this, args)
        })
      }

      const retval = query.apply(this, args)

      if (retval?.then) {
        retval.then(() => {
          finish(ctx)
        }).catch(() => {
          finish(ctx)
        })
      }

      return retval
    })
  }
}
