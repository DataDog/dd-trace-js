'use strict'

const { errorMonitor } = require('node:events')

const shimmer = require('../../datadog-shimmer')
const satisfies = require('../../../vendor/dist/semifies')
const { channel, addHook } = require('./helpers/instrument')

/** @type {WeakMap<object, Function>} */
const wrappedOnResult = new WeakMap()

/**
 * @param {Function} Connection
 * @param {string} version
 * @returns {Function}
 */
function wrapConnection (Connection, version) {
  const startCh = channel('apm:mysql2:query:start')
  const finishCh = channel('apm:mysql2:query:finish')
  const errorCh = channel('apm:mysql2:query:error')
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const commandAddCh = channel('apm:mysql2:command:add')
  const commandStartCh = channel('apm:mysql2:command:start')
  const commandFinishCh = channel('apm:mysql2:command:finish')
  const shouldEmitEndAfterQueryAbort = satisfies(version, '>=1.3.3')

  shimmer.wrap(Connection.prototype, 'addCommand', addCommand => function (cmd) {
    if (!startCh.hasSubscribers) return addCommand.apply(this, arguments)

    const command = /** @type {{ execute?: Function, constructor?: { name?: string } }} */ (cmd)
    if (typeof command.execute !== 'function') return addCommand.apply(this, arguments)

    const name = command.constructor?.name
    const isQuery = name === 'Execute' || name === 'Query'
    const ctx = {}

    if (isQuery) {
      command.execute = wrapExecute(command, command.execute, ctx, this.config)

      return commandAddCh.runStores(ctx, addCommand, this, ...arguments)
    }

    wrapCommandOnResult(command, ctx)
    command.execute = bindExecute(command.execute, ctx)

    return commandAddCh.runStores(ctx, addCommand, this, ...arguments)
  })

  shimmer.wrap(Connection.prototype, 'query', query => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return query.apply(this, arguments)

    const resolvedSql = /** @type {{ sql?: unknown }} */ (sql)?.sql
    if (!resolvedSql) return query.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql: resolvedSql, abortController })

    if (abortController.signal.aborted) {
      const addCommand = this.addCommand
      this.addCommand = function (cmd) { return cmd }

      let queryCommand
      try {
        queryCommand = query.apply(this, arguments)
      } finally {
        this.addCommand = addCommand
      }

      cb = queryCommand.onResult

      process.nextTick(() => {
        if (typeof cb === 'function') {
          cb(abortController.signal.reason)
        } else {
          queryCommand.emit('error', abortController.signal.reason)
        }

        if (shouldEmitEndAfterQueryAbort) {
          queryCommand.emit('end')
        }
      })

      return queryCommand
    }

    return query.apply(this, arguments)
  })

  shimmer.wrap(Connection.prototype, 'execute', execute => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return execute.apply(this, arguments)

    const resolvedSql = /** @type {{ sql?: unknown }} */ (sql)?.sql
    if (!resolvedSql) return execute.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql: resolvedSql, abortController })

    if (abortController.signal.aborted) {
      const addCommand = this.addCommand
      this.addCommand = function (cmd) { return cmd }

      let result
      try {
        result = execute.apply(this, arguments)
      } finally {
        this.addCommand = addCommand
      }

      if (typeof result?.onResult === 'function') {
        result.onResult(abortController.signal.reason)
      }

      return result
    }

    return execute.apply(this, arguments)
  })

  return Connection

  /**
   * @param {object} cmd
   * @param {object} ctx
   * @returns {void}
   */
  function wrapCommandOnResult (cmd, ctx) {
    const onResult = cmd?.onResult
    if (typeof onResult !== 'function') return

    const cached = wrappedOnResult.get(cmd)

    if (cached === onResult) return

    const wrapped = function () {
      return commandFinishCh.runStores(ctx, onResult, this, ...arguments)
    }

    wrappedOnResult.set(cmd, wrapped)
    cmd.onResult = wrapped
  }

  /**
   * @param {Function} execute
   * @param {object} ctx
   * @returns {Function}
   */
  function bindExecute (execute, ctx) {
    return shimmer.wrapFunction(execute, execute => function executeWithTrace (packet, connection) {
      return commandStartCh.runStores(ctx, execute, this, ...arguments)
    })
  }

  /**
   * @param {object} cmd
   * @param {Function} execute
   * @param {object} ctx
   * @param {object} config
   * @returns {Function}
   */
  function wrapExecute (cmd, execute, ctx, config) {
    return shimmer.wrapFunction(execute, execute => function executeWithTrace (packet, connection) {
      const command = /** @type {{ statement?: { query?: unknown }, sql?: unknown }} */ (cmd)
      ctx.sql = command.statement ? command.statement.query : command.sql
      ctx.conf = config

      return startCh.runStores(ctx, () => {
        if (command.statement) {
          command.statement.query = ctx.sql
        } else {
          command.sql = ctx.sql
        }

        if (typeof this.onResult === 'function') {
          const onResult = this.onResult

          this.onResult = shimmer.wrapFunction(onResult, onResult => function (error) {
            if (error) {
              ctx.error = error
              errorCh.publish(ctx)
            }
            finishCh.runStores(ctx, onResult, this, ...arguments)
          })
        } else {
          const command = /** @type {{ once?: Function }} */ (this)
          if (typeof command.once === 'function') {
            command.once(errorMonitor, error => {
              ctx.error = error
              errorCh.publish(ctx)
            })
            command.once('end', () => finishCh.publish(ctx))
          }
        }

        this.execute = execute

        try {
          return execute.apply(this, arguments)
        } catch (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }
      })
    })
  }
}
/**
 * @param {Function} Pool
 * @param {string} version
 * @returns {Function}
 */
function wrapPool (Pool, version) {
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const shouldEmitEndAfterQueryAbort = satisfies(version, '>=1.3.3')

  shimmer.wrap(Pool.prototype, 'query', query => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return query.apply(this, arguments)

    const resolvedSql = /** @type {{ sql?: unknown }} */ (sql)?.sql
    if (!resolvedSql) return query.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql: resolvedSql, abortController })

    if (abortController.signal.aborted) {
      const getConnection = this.getConnection
      this.getConnection = function () {}

      let queryCommand
      try {
        queryCommand = query.apply(this, arguments)
      } finally {
        this.getConnection = getConnection
      }

      process.nextTick(() => {
        if (queryCommand.onResult) {
          queryCommand.onResult(abortController.signal.reason)
        } else {
          queryCommand.emit('error', abortController.signal.reason)
        }

        if (shouldEmitEndAfterQueryAbort) {
          queryCommand.emit('end')
        }
      })

      return queryCommand
    }

    return query.apply(this, arguments)
  })

  shimmer.wrap(Pool.prototype, 'execute', execute => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return execute.apply(this, arguments)

    const resolvedSql = /** @type {{ sql?: unknown }} */ (sql)?.sql
    if (!resolvedSql) return execute.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql: resolvedSql, abortController })

    if (abortController.signal.aborted) {
      if (typeof values === 'function') {
        cb = values
      }

      if (typeof cb === 'function') {
        process.nextTick(() => {
          /** @type {Function} */ (cb)(abortController.signal.reason)
        })
      }
      return
    }

    return execute.apply(this, arguments)
  })

  return Pool
}

/**
 * @param {Function} PoolCluster
 * @returns {Function}
 */
function wrapPoolCluster (PoolCluster) {
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const wrappedPoolNamespaces = new WeakSet()

  shimmer.wrap(PoolCluster.prototype, 'of', of => function () {
    const poolNamespace = of.apply(this, arguments)

    if (startOuterQueryCh.hasSubscribers && !wrappedPoolNamespaces.has(poolNamespace)) {
      shimmer.wrap(poolNamespace, 'query', query => function (sql, values, cb) {
        const resolvedSql = /** @type {{ sql?: unknown }} */ (sql)?.sql
        if (!resolvedSql) return query.apply(this, arguments)

        const abortController = new AbortController()
        startOuterQueryCh.publish({ sql: resolvedSql, abortController })

        if (abortController.signal.aborted) {
          const getConnection = this.getConnection
          this.getConnection = function () {}

          let queryCommand
          try {
            queryCommand = query.apply(this, arguments)
          } finally {
            this.getConnection = getConnection
          }

          process.nextTick(() => {
            if (queryCommand.onResult) {
              queryCommand.onResult(abortController.signal.reason)
            } else {
              queryCommand.emit('error', abortController.signal.reason)
            }

            queryCommand.emit('end')
          })

          return queryCommand
        }

        return query.apply(this, arguments)
      })

      shimmer.wrap(poolNamespace, 'execute', execute => function (sql, values, cb) {
        const resolvedSql = /** @type {{ sql?: unknown }} */ (sql)?.sql
        if (!resolvedSql) return execute.apply(this, arguments)

        const abortController = new AbortController()
        startOuterQueryCh.publish({ sql: resolvedSql, abortController })

        if (abortController.signal.aborted) {
          if (typeof values === 'function') {
            cb = values
          }

          if (typeof cb === 'function') {
            process.nextTick(() => {
              /** @type {Function} */ (cb)(abortController.signal.reason)
            })
          }

          return
        }

        return execute.apply(this, arguments)
      })

      wrappedPoolNamespaces.add(poolNamespace)
    }

    return poolNamespace
  })

  return PoolCluster
}

addHook(
  { name: 'mysql2', file: 'lib/base/connection.js', versions: ['>=3.11.5'] },
  /** @type {(moduleExports: unknown, version: string) => unknown} */ (wrapConnection)
)
addHook(
  { name: 'mysql2', file: 'lib/connection.js', versions: ['1 - 3.11.4'] },
  /** @type {(moduleExports: unknown, version: string) => unknown} */ (wrapConnection)
)
addHook(
  { name: 'mysql2', file: 'lib/pool.js', versions: ['1 - 3.11.4'] },
  /** @type {(moduleExports: unknown, version: string) => unknown} */ (wrapPool)
)

// PoolNamespace.prototype.query does not exist in mysql2<2.3.0
addHook(
  { name: 'mysql2', file: 'lib/pool_cluster.js', versions: ['2.3.0 - 3.11.4'] },
  /** @type {(moduleExports: unknown, version: string) => unknown} */ (wrapPoolCluster)
)
