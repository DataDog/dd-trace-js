'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql2', file: 'lib/connection.js', versions: ['>=1'] }, Connection => {
  const startCh = channel('apm:mysql2:query:start')
  const finishCh = channel('apm:mysql2:query:finish')
  const errorCh = channel('apm:mysql2:query:error')

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

  return Connection

  function bindExecute (cmd, execute, asyncResource) {
    return asyncResource.bind(function executeWithTrace (packet, connection) {
      if (this.onResult) {
        this.onResult = asyncResource.bind(this.onResult)
      }

      return execute.apply(this, arguments)
    }, cmd)
  }

  function wrapExecute (cmd, execute, asyncResource, config) {
    const callbackResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.bind(function executeWithTrace (packet, connection) {
      const sql = cmd.statement ? cmd.statement.query : cmd.sql

      startCh.publish({ sql, conf: config })

      if (this.onResult) {
        const onResult = callbackResource.bind(this.onResult)

        this.onResult = asyncResource.bind(function (error) {
          if (error) {
            errorCh.publish(error)
          }
          finishCh.publish(undefined)
          onResult.apply(this, arguments)
        }, 'bound-anonymous-fn', this)
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
    }, cmd)
  }
})
