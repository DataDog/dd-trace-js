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
// Commands sent before the connection is ready, and unfulfilled commands resent after a
// reconnect, are replayed through `sendCommand`. Only those are tracked, and only looked up
// while any of them is pending.
const queuedCommands = new WeakSet()
let pendingQueuedCommands = 0

function wrapRedis (Redis) {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers || !command?.promise ||
      (pendingQueuedCommands !== 0 && queuedCommands.has(command))) {
      return sendCommand.call(this, command, stream)
    }

    if (this.status !== 'ready') trackReplay(command)

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
      command.promise.then(() => finish(ctx), err => finish(ctx, err))

      return sendCommand.call(this, command, stream)
    })
  })
  // The close handler moves in-flight commands to `prevCommandQueue` right before this.
  shimmer.wrap(Redis.prototype, 'setStatus', setStatus => function (status, arg) {
    const queue = status === 'reconnecting' && startCh.hasSubscribers &&
      this.options?.autoResendUnfulfilledCommands && this.prevCommandQueue
    if (queue) {
      for (let i = 0; i < queue.length; i++) {
        const { command } = queue.get(i)
        if (command?.promise && !queuedCommands.has(command)) trackReplay(command)
      }
    }
    return setStatus.call(this, status, arg)
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

function trackReplay (command) {
  queuedCommands.add(command)
  pendingQueuedCommands++
  command.promise.then(settleQueuedCommand, settleQueuedCommand)
}

function settleQueuedCommand () {
  pendingQueuedCommands--
}

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
