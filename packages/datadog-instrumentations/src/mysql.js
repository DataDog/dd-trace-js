'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const asyncEndCh = channel('apm:mysql:query:async-end')
  const endCh = channel('apm:mysql:query:end')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function () {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const sql = arguments[0].sql ? arguments[0].sql : arguments[0]
    const startArgs = [sql, this.config]

    startCh.publish(startArgs)

    try {
      const res = query.apply(this, arguments)

      if (res._callback) {
        const cb = asyncResource.bind(res._callback)
        res._callback = AsyncResource.bind(function (error, result) {
          if (error) {
            errorCh.publish(error)
          }
          asyncEndCh.publish(result)

          return cb.apply(this, arguments)
        })
      } else {
        const cb = AsyncResource.bind(function () {
          asyncEndCh.publish(undefined)
        })
        res.on('end', cb)
      }

      return res
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })

  return Connection
})

addHook({ name: 'mysql', file: 'lib/Pool.js', versions: ['>=2'] }, Pool => {
  shimmer.wrap(Pool.prototype, 'getConnection', getConnection => function (cb) {
    arguments[0] = AsyncResource.bind(cb)
    return getConnection.apply(this, arguments)
  })
  return Pool
})

addHook({ name: 'mysql2', file: 'lib/connection.js', versions: ['>=1'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const asyncEndCh = channel('apm:mysql:query:async-end')
  const endCh = channel('apm:mysql:query:end')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'addCommand', addCommand => function (cmd) {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const name = cmd && cmd.constructor && cmd.constructor.name
    const isCommand = typeof cmd.execute === 'function'
    const isSupported = name === 'Execute' || name === 'Query'

    if (!(isCommand && isSupported)) {
      return addCommand.apply(this, arguments)
    }

    const sql = cmd.statement ? cmd.statement.query : cmd.sql
    startCh.publish([sql, this.config])

    try {
      const res = addCommand.apply(this, arguments)

      if (res.onResult) {
        const cb = bindAsyncResource.call(asyncResource, res.onResult)
        res.onResult = bind(function (error, result) {
          if (error) {
            errorCh.publish(error)
          }
          asyncEndCh.publish(result)

          return cb.apply(this, arguments)
        })
      } else {
        const cb = bind(function () {
          asyncEndCh.publish(undefined)
        })

        const cb2 = bind(error => errorCh.publish(error))
        res.on('error', cb2)
        res.on('end', cb)
      }

      return res
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return Connection
})

addHook({ name: 'mysql2', file: 'lib/commands/command.js', versions: ['>=1'] }, Command => {
  shimmer.wrap(Command.prototype, 'on', on => function (name, fn) {
    const bound = bind(fn)
    on.call(this, name, bound)
  })
  return Command
})
