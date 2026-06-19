'use strict'

const { performance } = require('node:perf_hooks')

// Carry the wait a pooled connection spent being acquired over to the first query that runs on it, so
// the query span can report the pool wait without a dedicated span for the common `pool.query` path.
// Keyed by the connection, which is also `this` when its first command runs.
/** @type {WeakMap<object, number>} */
const poolWaitTimes = new WeakMap()

// `Pool#query` / `Pool#execute` acquire a connection internally via `getConnection`. That acquire is
// reported as a tag on the resulting query span, so the `getConnection` wrap must not also open a
// standalone acquire span for it; an explicit user `getConnection()` gets the span instead.
// `getConnection` runs synchronously from within those methods, so a flag set around the call
// reliably distinguishes the two. mysql and mysql2 never share a `getConnection` call stack, so a
// single module-level flag is safe across both.
let acquiringForPoolQuery = false

/**
 * @returns {boolean}
 */
function isPoolQueryAcquire () {
  return acquiringForPoolQuery
}

/**
 * Bracket a pool `query` / `execute` so the connection it acquires internally is treated as a
 * pooled-query acquire rather than an explicit one.
 *
 * @param {Function} method
 * @returns {Function}
 */
function wrapPoolQueryMethod (method) {
  return function () {
    acquiringForPoolQuery = true
    try {
      return method.apply(this, arguments)
    } finally {
      acquiringForPoolQuery = false
    }
  }
}

/**
 * An idle connection is handed back within a tick, so treat that as a zero wait and skip the clock
 * reads; only a queued or freshly established connection is worth timing. mysql / mysql2 expose the
 * free list as `_freeConnections`, mariadb as an `idleConnections()` count; an absent source falls
 * through to timing rather than crashing.
 *
 * @param {{ _freeConnections?: { length: number }, idleConnections?: () => number }} pool
 * @returns {number|undefined}
 */
function acquireStart (pool) {
  const idleConnections = pool._freeConnections?.length ?? pool.idleConnections?.()
  return idleConnections > 0 ? undefined : performance.now()
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
 * @param {number} waitTime
 */
function setPoolWaitTime (connection, waitTime) {
  poolWaitTimes.set(connection, waitTime)
}

/**
 * Read and clear the wait time recorded for a connection at acquire time.
 *
 * @param {object} connection
 * @returns {number|undefined}
 */
function takePoolWaitTime (connection) {
  const waitTime = poolWaitTimes.get(connection)
  if (waitTime !== undefined) {
    poolWaitTimes.delete(connection)
  }
  return waitTime
}

module.exports = {
  acquireStart,
  acquireWait,
  isPoolQueryAcquire,
  setPoolWaitTime,
  takePoolWaitTime,
  wrapPoolQueryMethod,
}
