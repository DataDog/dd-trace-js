'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:ioredis:command:start')
const finishCh = channel('apm:ioredis:command:finish')
const errorCh = channel('apm:ioredis:command:error')

const connectionOptionsSymbol = Symbol('dd-trace.ioredis.connectionOptions')

function wrapRedis (Redis) {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers) return sendCommand.apply(this, arguments)

    if (!command || !command.promise) return sendCommand.apply(this, arguments)

    const options = this.options || {}
    let connectionOptions = this[connectionOptionsSymbol]
    if (connectionOptions === undefined) {
      connectionOptions = { host: options.host, port: options.port }
      this[connectionOptionsSymbol] = connectionOptions
    }

    const ctx = {
      db: options.db,
      command: command.name,
      args: command.args,
      connectionOptions,
      connectionName: options.connectionName,
    }
    return startCh.runStores(ctx, () => {
      command.promise.then(() => finish(finishCh, errorCh, ctx), err => finish(finishCh, errorCh, ctx, err))

      return sendCommand.apply(this, arguments)
    })
  })
  return Redis
}

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/redis.js' }, wrapRedis)

addHook({ name: 'ioredis', versions: ['>=4 <4.11.0'], file: 'built/redis.js' }, wrapRedis)

addHook({ name: 'ioredis', versions: ['>=4.11.0 <5'], file: 'built/redis/index.js' }, (exports) => {
  wrapRedis(exports.default)
  return exports
})

addHook({ name: 'ioredis', versions: ['>=5'] }, wrapRedis)

function finish (finishCh, errorCh, ctx, error) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.publish(ctx)
}
