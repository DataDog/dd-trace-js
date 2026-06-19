'use strict'

const { errorMonitor } = require('node:events')
const { performance } = require('node:perf_hooks')

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:pg:query:start')
const finishCh = channel('apm:pg:query:finish')
const errorCh = channel('apm:pg:query:error')

const startPoolQueryCh = channel('datadog:pg:pool:query:start')
const finishPoolQueryCh = channel('datadog:pg:pool:query:finish')

const poolConnectStartCh = channel('apm:pg:pool:connect:start')
const poolConnectFinishCh = channel('apm:pg:pool:connect:finish')

const poolAcquireStartCh = channel('apm:pg:pool:acquire:start')
const poolAcquireFinishCh = channel('apm:pg:pool:acquire:finish')

// Drivers like pg-promise reuse the same prepared-statement query object across executions; cache
// the un-injected `text` so the wrap doesn't capture a previous DBM injection as the new original.
const originalTextCache = new WeakMap()

// Carry the time a pooled client spent being acquired from the connect callback over to the first
// query run on that client, so the query span can report the pool wait the query actually paid for.
const poolWaitTimes = new WeakMap()

// `Pool.prototype.query` acquires a client internally via `connect`. That acquire is reported as a
// tag on the resulting query span, so the connect wrap must not also open a standalone acquire span
// for it; an explicit user `pool.connect()` gets the standalone span instead. `connect` is invoked
// synchronously from within `query`, so a module flag set around the call reliably distinguishes them.
let acquiringForPoolQuery = false

addHook({ name: 'pg', versions: ['>=8.0.3'], file: 'lib/native/client.js' }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

addHook({ name: 'pg', versions: ['>=8.0.3'], file: 'lib/client.js' }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

addHook({ name: 'pg', versions: ['>=8.0.3'] }, pg => {
  // pg defers a busy pool's connect callback and runs it in the releasing query's async context;
  // capture the caller's context and restore it around the callback so spans attach to the caller.
  shimmer.wrap(pg.Pool.prototype, 'connect', connect => function (cb) {
    const explicit = !acquiringForPoolQuery

    // `await pool.connect()`: no callback, so the caller's async context is preserved by the await
    // itself and only the standalone acquire span is needed. `Pool.query` always acquires with a
    // callback, so a missing callback is always an explicit caller-initiated acquire.
    if (typeof cb !== 'function') {
      if (!poolAcquireStartCh.hasSubscribers) {
        return connect.apply(this, arguments)
      }

      const start = acquireStart(this)
      const acquireCtx = { poolOptions: this.options }
      poolAcquireStartCh.publish(acquireCtx)

      return connect.apply(this, arguments).then(client => {
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
    const start = acquireStart(this)
    const acquireCtx = explicit ? { poolOptions: this.options } : undefined
    if (acquireCtx !== undefined) {
      poolAcquireStartCh.publish(acquireCtx)
    }
    arguments[0] = function (...args) {
      if (acquireCtx === undefined) {
        const client = args[1]
        if (client !== undefined) {
          poolWaitTimes.set(client, acquireWait(start))
        }
      } else {
        acquireCtx.error = args[0]
        finishAcquire(acquireCtx, start)
      }
      return poolConnectFinishCh.runStores(ctx, cb, this, ...args)
    }

    poolConnectStartCh.publish(ctx)

    return connect.apply(this, arguments)
  })
  shimmer.wrap(pg.Pool.prototype, 'query', query => wrapPoolQuery(query))
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

    const poolWaitTime = poolWaitTimes.get(this)
    if (poolWaitTime !== undefined) {
      poolWaitTimes.delete(this)
      ctx.poolWaitTime = poolWaitTime
    }
    const finish = (error, res) => {
      if (error) {
        ctx.error = error
        errorCh.publish(ctx)
      }
      ctx.result = res?.rows
      return finishCh.publish(ctx)
    }
    return startCh.runStores(ctx, () => {
      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')

        // Based on: https://github.com/brianc/node-postgres/blob/54eb0fa216aaccd727765641e7d1cf5da2bc483d/packages/pg/lib/client.js#L510
        const reusingQuery = typeof pgQuery.submit === 'function'
        const callback = args[args.length - 1]

        finish(error)

        if (reusingQuery) {
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

      const retval = query.apply(this, args)

      const deperecated = Object.hasOwn(this, '_activeQuery')
      const queryQueue = deperecated ? this._queryQueue : this.queryQueue
      const activeQuery = deperecated ? this._activeQuery : this.activeQuery

      const newQuery = queryQueue.at(-1) || activeQuery

      if (!newQuery) {
        return retval
      }

      if (newQuery.callback) {
        const originalCallback = newQuery.callback
        newQuery.callback = function (err, ...args) {
          finish(err, ...args)
          return finishCh.runStores(ctx, originalCallback, this, err, ...args)
        }
      } else if (newQuery.once) {
        newQuery
          .once(errorMonitor, finish)
          .once('end', (res) => finish(null, res))
      } else {
        // TODO: This code is never reached in our tests.
        // Internally, pg always uses callbacks or streams, even for promise based queries.
        // Investigate if this code should just be removed.
        newQuery.then((res) => finish(null, res), finish)
      }

      try {
        return retval
      } catch (error) {
        ctx.error = error
        errorCh.publish(ctx)
      }
    })
  }
}
const finish = (ctx) => {
  finishPoolQueryCh.publish(ctx)
}
// pg drains its pending queue FIFO on the next tick, so within a synchronous burst `idleCount` is
// stale: an idle client is only ours when it outnumbers the already-waiting requests ahead of us.
// `idleCount > waitingCount` means the handoff lands within a tick (zero wait, skip the clock);
// otherwise we wait for a connection or a release and time it. Both getters are `undefined` on pg
// builds that predate them, so the check is false and falls through to timing rather than crashing.
function acquireStart (pool) {
  return pool.idleCount > pool.waitingCount ? undefined : performance.now()
}
function acquireWait (start) {
  return start === undefined ? 0 : performance.now() - start
}
function finishAcquire (ctx, start) {
  ctx.poolWaitTime = acquireWait(start)
  poolAcquireFinishCh.publish(ctx)
}
function wrapPoolQuery (query) {
  return function (...args) {
    acquiringForPoolQuery = true
    try {
      return poolQuery.call(this, query, args)
    } finally {
      acquiringForPoolQuery = false
    }
  }
}
function poolQuery (query, args) {
  if (!startPoolQueryCh.hasSubscribers) {
    return query.apply(this, args)
  }

  const pgQuery = args[0] !== null && typeof args[0] === 'object' ? args[0] : { text: args[0] }
  const abortController = new AbortController()

  const ctx = { query: pgQuery, abortController }

  return startPoolQueryCh.runStores(ctx, () => {
    const cb = args[args.length - 1]

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
