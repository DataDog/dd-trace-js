'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const semver = require('semver')

function wrapConnection (Connection, version) {
  const startCh = channel('apm:mysql2:query:start')
  const finishCh = channel('apm:mysql2:query:finish')
  const errorCh = channel('apm:mysql2:query:error')
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const shouldEmitEndAfterQueryAbort = semver.intersects(version, '>=1.3.3')

  shimmer.wrap(Connection.prototype, 'addCommand', addCommand => function (cmd) {
    if (!startCh.hasSubscribers) return addCommand.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const name = cmd && cmd.constructor && cmd.constructor.name
    const isCommand = typeof cmd.execute === 'function'
    const isQuery = isCommand && (name === 'Execute' || name === 'Query')

    // TODO: consider supporting all commands and not just queries
    cmd.execute = isQuery
      ? wrapExecute(cmd, cmd.execute, asyncResource, this.config)
      : bindExecute(cmd, cmd.execute, asyncResource)

    return asyncResource.bind(addCommand, this).apply(this, arguments)
  })

  shimmer.wrap(Connection.prototype, 'query', query => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return query.apply(this, arguments)

    if (typeof sql === 'object') sql = sql?.sql

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

    if (typeof sql === 'object') sql = sql?.sql

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

  function bindExecute (cmd, execute, asyncResource) {
    return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
      if (this.onResult) {
        this.onResult = asyncResource.bind(this.onResult)
      }

      return execute.apply(this, arguments)
    }, cmd))
  }

  function wrapExecute (cmd, execute, asyncResource, config) {
    const callbackResource = new AsyncResource('bound-anonymous-fn')

    return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
      const sql = cmd.statement ? cmd.statement.query : cmd.sql
      const payload = { sql, conf: config }
      startCh.publish(payload)

      if (cmd.statement) {
        cmd.statement.query = payload.sql
      } else {
        cmd.sql = payload.sql
      }

      if (this.onResult) {
        const onResult = callbackResource.bind(this.onResult)

        this.onResult = shimmer.wrapFunction(onResult, onResult => asyncResource.bind(function (error) {
          if (error) {
            errorCh.publish(error)
          }
          finishCh.publish(undefined)
          onResult.apply(this, arguments)
        }, 'bound-anonymous-fn', this))
      } else {
        this.on('error', asyncResource.bind(error => errorCh.publish(error)))
        this.on('end', asyncResource.bind(() => finishCh.publish(undefined)))
      }

      this.execute = execute

      try {
        return execute.apply(this, arguments)
      } catch (err) {
        errorCh.publish(err)
      }
    }, cmd))
  }
}
function wrapPool (Pool, version) {
  const startOuterQueryCh = channel('datadog:mysql2:outerquery:start')
  const shouldEmitEndAfterQueryAbort = semver.intersects(version, '>=1.3.3')

  shimmer.wrap(Pool.prototype, 'query', query => function (sql, values, cb) {
    if (!startOuterQueryCh.hasSubscribers) return query.apply(this, arguments)

    if (typeof sql === 'object') sql = sql?.sql

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

    if (typeof sql === 'object') sql = sql?.sql

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
        if (typeof sql === 'object') sql = sql?.sql

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
        if (typeof sql === 'object') sql = sql?.sql

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
