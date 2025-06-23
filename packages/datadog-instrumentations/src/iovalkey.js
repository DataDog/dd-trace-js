'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:iovalkey:command:start')
const finishCh = channel('apm:iovalkey:command:finish')
const errorCh = channel('apm:iovalkey:command:error')

addHook({ name: 'iovalkey', versions: ['>=0.0.1'] }, Valkey => {
  shimmer.wrap(Valkey.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers) return sendCommand.apply(this, arguments)

    if (!command?.promise) return sendCommand.apply(this, arguments)

    const options = this.options || {}
    const connectionName = options.connectionName
    const db = options.db
    const connectionOptions = { host: options.host, port: options.port }

    const ctx = { db, command: command.name, args: command.args, connectionOptions, connectionName }
    return startCh.runStores(ctx, () => {
      command.promise.then(() => finish(finishCh, errorCh, ctx), err => finish(finishCh, errorCh, ctx, err))

      try {
        return sendCommand.apply(this, arguments)
      } catch (err) {
        ctx.error = err
        errorCh.publish(ctx)

        throw err
      }
    })
  })
  return Valkey
})

function finish (finishCh, errorCh, ctx, error) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.publish(ctx)
}
