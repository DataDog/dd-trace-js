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
let pendingReplays = 0
let replayCommands

function wrapRedis (Redis) {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers || !command?.promise ||
        ((pendingReplays !== 0 || stream) && replayCommands?.has(command))) {
      return sendCommand.call(this, command, stream)
    }

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
      command.promise.then(() => finish(ctx), error => finish(ctx, error))
      if (stream) trackReplay(command)

      return sendCommand.call(this, command, stream)
    })
  })

  const errorHandler = Redis.prototype.handleReconnection ? 'handleReconnection' : 'returnError'
  shimmer.wrap(Redis.prototype, errorHandler, handleReconnection => function (error, item) {
    if (startCh.hasSubscribers) {
      const command = item ? item.command : this.commandQueue.get(0).command
      trackReplay(command)
    }
    return handleReconnection.call(this, error, item)
  })
  shimmer.wrap(Redis.prototype, 'flushQueue', flushQueue => function () {
    if (startCh.hasSubscribers) {
      trackQueue(this.offlineQueue)
      trackQueue(this.commandQueue)
    }
    return flushQueue.apply(this, arguments)
  })
  return Redis
}

/** @param {typeof import('ioredis/built/redis/event_handler')} handlers */
function wrapReadyHandler (handlers) {
  // The queue drain runs in a callback created at runtime by this factory.
  shimmer.wrap(handlers, 'readyHandler', readyHandler => function (self) {
    const ready = readyHandler.apply(this, arguments)
    return function () {
      if (startCh.hasSubscribers) {
        trackQueue(self.offlineQueue)
        if (self.options.autoResendUnfulfilledCommands) trackQueue(self.prevCommandQueue)
      }
      return ready.apply(this, arguments)
    }
  })
  return handlers
}

/**
 * @param {import('denque')<{ command: import('ioredis').Command }> | undefined} queue
 */
function trackQueue (queue) {
  for (let i = 0; i < (queue?.length ?? 0); i++) {
    trackReplay(queue.get(i).command)
  }
}

/** @param {import('ioredis').Command} command */
function trackReplay (command) {
  const commands = replayCommands ??= new WeakSet()
  if (commands.has(command)) return
  commands.add(command)
  pendingReplays++
  const clear = () => { pendingReplays-- }
  command.promise.then(clear, clear)
}

addHook({ name: 'ioredis', versions: ['>=6'], file: 'built/himport/HimportCoordinator.js' }, exports => {
  shimmer.wrap(exports, 'interceptHimportCommand', intercept => function (redis, command, ready, resumeSend) {
    if (!startCh.hasSubscribers) return intercept.apply(this, arguments)
    return intercept.call(this, redis, command, ready, () => {
      if (startCh.hasSubscribers) trackReplay(command)
      return resumeSend()
    })
  })
  return exports
})

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/redis/event_handler.js' }, wrapReadyHandler)
addHook({ name: 'ioredis', versions: ['>=4'], file: 'built/redis/event_handler.js' }, wrapReadyHandler)

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/redis.js' }, wrapRedis)

addHook({ name: 'ioredis', versions: ['>=4 <4.11.0'], file: 'built/redis.js' }, wrapRedis)

addHook({ name: 'ioredis', versions: ['>=4.11.0 <5'], file: 'built/redis/index.js' }, (exports) => {
  wrapRedis(exports.default)
  return exports
})

addHook({ name: 'ioredis', versions: ['>=5'] }, wrapRedis)

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
