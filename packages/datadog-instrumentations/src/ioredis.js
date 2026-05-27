'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:ioredis:command:start')
const finishCh = channel('apm:ioredis:command:finish')
const errorCh = channel('apm:ioredis:command:error')

const connectionOptionsCache = new WeakMap()

function wrapRedis (Redis) {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers) return sendCommand.call(this, command, stream)

    if (!command?.promise) return sendCommand.call(this, command, stream)

    const options = this.options || {}
    let connectionOptions = connectionOptionsCache.get(this)
    if (connectionOptions === undefined) {
      connectionOptions = { host: options.host, port: options.port }
      connectionOptionsCache.set(this, connectionOptions)
    }

    const ctx = {
      command: command.name,
      args: command.args,
      connectionOptions,
      connectionName: options.connectionName,
    }
    return startCh.runStores(ctx, () => {
      command.promise.then(() => finish(finishCh, errorCh, ctx), err => finish(finishCh, errorCh, ctx, err))

      return sendCommand.call(this, command, stream)
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

addHook({ name: 'ioredis', versions: ['>=5 <5.11.0'] }, wrapRedis)

// ioredis >= 5.11.0 exposes a built-in TracingChannel (tracing:ioredis:command).
// On Node.js versions that support dc.tracingChannel (>= 19.9 / 20.2), the plugin
// subscribes directly to those channels and no shimmer is needed. Fall back to the
// shimmer approach on older Node.js runtimes.
addHook({ name: 'ioredis', versions: ['>=5.11.0'] }, (Redis) => {
  if (typeof require('node:diagnostics_channel').tracingChannel === 'function') {
    return Redis
  }
  return wrapRedis(Redis)
})

function finish (finishCh, errorCh, ctx, error) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  finishCh.publish(ctx)
}
