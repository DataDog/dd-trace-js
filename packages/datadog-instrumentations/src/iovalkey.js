'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:iovalkey:command:start')
const finishCh = channel('apm:iovalkey:command:finish')
const errorCh = channel('apm:iovalkey:command:error')

addHook({ name: 'iovalkey', versions: ['>=0.0.1'] }, Valkey => {
  shimmer.wrap(Valkey.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers || !command?.promise) return sendCommand.apply(this, arguments)

    const options = this.options || {}
    const connectionName = options.connectionName
    const connectionOptions = { host: options.host, port: options.port }

    const ctx = { command: command.name, args: command.args, connectionOptions, connectionName }
    return startCh.runStores(ctx, () => {
      command.promise.then(() => finish(ctx), err => finish(ctx, err))

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

/**
 * @param {Record<string, unknown> & { error?: Error }} ctx
 * @param {Error} [error]
 */
function finish (ctx, error) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.publish(ctx)
}
