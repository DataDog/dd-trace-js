'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:ioredis:command:start')
const finishCh = channel('apm:ioredis:command:finish')
const errorCh = channel('apm:ioredis:command:error')

addHook({ name: 'ioredis', versions: ['>=2'] }, Redis => {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers) return sendCommand.apply(this, arguments)

    if (!command || !command.promise) return sendCommand.apply(this, arguments)

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
        errorCh.publish(err)

        throw err
      }
    })
  })
  return Redis
})

function finish (finishCh, errorCh, ctx, error) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.publish(ctx)
}
