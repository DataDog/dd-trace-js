'use strict'

const { AsyncResource } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindAsyncResource,
  bindEventEmitter
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql2', file: 'lib/connection.js', versions: ['>=1'] }, Connection => {
  const startCh = channel('apm:mysql2:addCommand:start')
  const asyncEndCh = channel('apm:mysql2:addCommand:async-end')
  const endCh = channel('apm:mysql2:addCommand:end')
  const errorCh = channel('apm:mysql2:addCommand:error')

  shimmer.wrap(Connection.prototype, 'addCommand', addCommand => function (cmd) {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const name = cmd && cmd.constructor && cmd.constructor.name
    const isCommand = typeof cmd.execute === 'function'
    const isSupported = name === 'Execute' || name === 'Query'

    if (isCommand && isSupported) {
      const sql = cmd.statement ? cmd.statement.query : cmd.sql
      startCh.publish([sql, this.config])
    } else {
      return addCommand.apply(this, arguments)
    }

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
  bindEventEmitter(Command.prototype)
  return Command
})