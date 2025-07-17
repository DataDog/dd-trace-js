'use strict'

const { errorMonitor } = require('node:events')

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const satisfies = require('semifies')

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

    const name = cmd && cmd.constructor && cmd.constructor.name
    const isCommand = typeof cmd.execute === 'function'
    const isQuery = isCommand && (name === 'Execute' || name === 'Query')
    const ctx = {}

    // TODO: consider supporting all commands and not just queries
    cmd.execute = isQuery
      ? wrapExecute(cmd, cmd.execute, ctx, this.config)
      : bindExecute(cmd.execute, ctx)

    return commandAddCh.runStores(ctx, addCommand, this, ...arguments)
  })

  shimmer.wrap(Connection.prototype, 'query', query => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return query.apply(this, arguments)

    if (sql !== null && typeof sql === 'object') sql = sql.sql

    if (!sql) return query.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql, abortController })

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
        if (cb) {
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

    if (sql !== null && typeof sql === 'object') sql = sql.sql

    if (!sql) return execute.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql, abortController })

    if (abortController.signal.aborted) {
      const addCommand = this.addCommand
      this.addCommand = function (cmd) { return cmd }

      let result
      try {
        result = execute.apply(this, arguments)
      } finally {
        this.addCommand = addCommand
      }

      result?.onResult(abortController.signal.reason)

      return result
    }

    return execute.apply(this, arguments)
  })

  return Connection

  function bindExecute (execute, ctx) {
    return shimmer.wrapFunction(execute, execute => function executeWithTrace (packet, connection) {
      const onResult = this.onResult

      if (onResult) {
        this.onResult = function () {
          return commandFinishCh.runStores(ctx, onResult, this, ...arguments)
        }
      }

      return commandStartCh.runStores(ctx, execute, this, ...arguments)
    })
  }

  function wrapExecute (cmd, execute, ctx, config) {
    return shimmer.wrapFunction(execute, execute => function executeWithTrace (packet, connection) {
      ctx.sql = cmd.statement ? cmd.statement.query : cmd.sql
      ctx.conf = config

      return startCh.runStores(ctx, () => {
        if (cmd.statement) {
          cmd.statement.query = ctx.sql
        } else {
          cmd.sql = ctx.sql
        }

        if (this.onResult) {
          const onResult = this.onResult

          this.onResult = shimmer.wrapFunction(onResult, onResult => function (error) {
            if (error) {
              ctx.error = error
              errorCh.publish(ctx)
            }
            finishCh.runStores(ctx, onResult, this, ...arguments)
          })
        } else {
          this.on(errorMonitor, error => {
            ctx.error = error
            errorCh.publish(ctx)
          })
          this.on('end', () => finishCh.publish(ctx))
        }

        this.execute = execute

        try {
          return execute.apply(this, arguments)
        } catch (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }
      })
    }, cmd)
  }
}
function wrapPool (Pool, version) {
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const shouldEmitEndAfterQueryAbort = satisfies(version, '>=1.3.3')

  shimmer.wrap(Pool.prototype, 'query', query => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return query.apply(this, arguments)

    if (sql !== null && typeof sql === 'object') sql = sql.sql

    if (!sql) return query.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql, abortController })

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

    if (sql !== null && typeof sql === 'object') sql = sql.sql

    if (!sql) return execute.apply(this, arguments)

    const abortController = new AbortController()
    startOuterQueryCh.publish({ sql, abortController })

    if (abortController.signal.aborted) {
      if (typeof values === 'function') {
        cb = values
      }

      process.nextTick(() => {
        cb(abortController.signal.reason)
      })
      return
    }

    return execute.apply(this, arguments)
  })

  return Pool
}

function wrapPoolCluster (PoolCluster) {
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const wrappedPoolNamespaces = new WeakSet()

  shimmer.wrap(PoolCluster.prototype, 'of', of => function () {
    const poolNamespace = of.apply(this, arguments)

    if (startOuterQueryCh.hasSubscribers && !wrappedPoolNamespaces.has(poolNamespace)) {
      shimmer.wrap(poolNamespace, 'query', query => function (sql, values, cb) {
        if (sql !== null && typeof sql === 'object') sql = sql.sql

        if (!sql) return query.apply(this, arguments)

        const abortController = new AbortController()
        startOuterQueryCh.publish({ sql, abortController })

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
        if (sql !== null && typeof sql === 'object') sql = sql.sql

        if (!sql) return execute.apply(this, arguments)

        const abortController = new AbortController()
        startOuterQueryCh.publish({ sql, abortController })

        if (abortController.signal.aborted) {
          if (typeof values === 'function') {
            cb = values
          }

          process.nextTick(() => {
            cb(abortController.signal.reason)
          })

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

addHook({ name: 'mysql2', file: 'lib/base/connection.js', versions: ['>=3.11.5'] }, wrapConnection)
addHook({ name: 'mysql2', file: 'lib/connection.js', versions: ['1 - 3.11.4'] }, wrapConnection)
addHook({ name: 'mysql2', file: 'lib/pool.js', versions: ['1 - 3.11.4'] }, wrapPool)

// PoolNamespace.prototype.query does not exist in mysql2<2.3.0
addHook({ name: 'mysql2', file: 'lib/pool_cluster.js', versions: ['2.3.0 - 3.11.4'] }, wrapPoolCluster)
