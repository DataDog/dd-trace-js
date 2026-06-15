'use strict'

const { performance } = require('node:perf_hooks')

// Shared wrap for promise-based pool acquisition in query builders / ORMs that own their own pool
// (knex `Client#acquireConnection` over tarn, sequelize `ConnectionManager#getConnection` over
// sequelize-pool). Unlike a driver's `pool.query`, every ORM query acquires a connection, so opening
// a span on every acquire would roughly double the span count. The span is therefore only opened when
// the pool has no connection ready to hand back (a real wait); a warm pool takes the fast path with
// neither a span nor a clock read. The wait is reported as the span duration and a `wait_time` tag.

/**
 * @param {Function} acquire The original acquire method. Must return a promise resolving to the connection.
 * @param {import('node:diagnostics_channel').Channel} startCh Published synchronously before the wait begins.
 * @param {import('node:diagnostics_channel').Channel} finishCh Published once the wait resolves or rejects.
 * @param {(self: object, args: IArguments) => { conf?: object, dialect?: string }} buildContext
 *   Builds the channel context (connection settings and dialect) for the plugin to tag the span.
 * @param {(self: object, args: IArguments) => boolean} hasIdleConnection
 *   True when a connection can be handed back without waiting, in which case no span is opened.
 * @returns {Function}
 */
function wrapPoolAcquire (acquire, startCh, finishCh, buildContext, hasIdleConnection) {
  return function () {
    if (!startCh.hasSubscribers || hasIdleConnection(this, arguments)) {
      return acquire.apply(this, arguments)
    }

    const ctx = buildContext(this, arguments)
    const start = performance.now()
    // Publish synchronously so the span is parented to the caller's active span before the await.
    startCh.publish(ctx)

    return acquire.apply(this, arguments).then(connection => {
      ctx.poolWaitTime = performance.now() - start
      finishCh.publish(ctx)
      return connection
    }, error => {
      ctx.poolWaitTime = performance.now() - start
      ctx.error = error
      finishCh.publish(ctx)
      throw error
    })
  }
}

module.exports = { wrapPoolAcquire }
