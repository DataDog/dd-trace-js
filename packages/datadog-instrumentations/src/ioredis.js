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
let replayDepth = 0
let replayCommands
let resendingCommand

function wrapRedis (Redis) {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers || !command?.promise ||
        (replayDepth !== 0 && (resendingCommand === command || replayCommands?.has(command)))) {
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
      command.promise.then(() => finish(ctx), err => finish(ctx, err))

      return sendCommand.call(this, command, stream)
    })
  })

  const errorHandler = Redis.prototype.handleReconnection ? 'handleReconnection' : 'returnError'
  shimmer.wrap(Redis.prototype, errorHandler, handleReconnection => function (error, item) {
    if (!startCh.hasSubscribers) return handleReconnection.call(this, error, item)

    const command = item ? item.command : this.commandQueue.get(0).command
    return runReplay(command, () => handleReconnection.call(this, error, item))
  })
  shimmer.wrap(Redis.prototype, 'flushQueue', flushQueue => function () {
    return replayQueue([this.offlineQueue, this.commandQueue], () => flushQueue.apply(this, arguments))
  })
  return Redis
}

/** @param {typeof import('ioredis/built/redis/event_handler')} handlers */
function wrapReadyHandler (handlers) {
  // The queue drain runs in a callback created at runtime by this factory.
  shimmer.wrap(handlers, 'readyHandler', readyHandler => function (self) {
    const ready = readyHandler.apply(this, arguments)
    return function () {
      const offlineQueue = self.offlineQueue
      const previousQueue = self.options.autoResendUnfulfilledCommands ? self.prevCommandQueue : undefined
      if (!startCh.hasSubscribers || (offlineQueue.length === 0 && !previousQueue?.length)) {
        return ready.apply(this, arguments)
      }

      return replayQueue([offlineQueue, previousQueue], () => ready.apply(this, arguments))
    }
  })
  return handlers
}

/**
 * @param {Array<import('denque')<{ command: import('ioredis').Command }> | undefined>} queues
 * @param {() => void} send
 */
function replayQueue (queues, send) {
  if (!startCh.hasSubscribers || queues.every(queue => !queue?.length)) return send()
  // Commands can move between native queues before being resent.
  const commands = replayCommands ??= new WeakSet()
  for (const queue of queues) {
    for (let i = 0; i < (queue?.length ?? 0); i++) {
      commands.add(queue.get(i).command)
    }
  }
  return runReplay(resendingCommand, send)
}

/**
 * @param {import('ioredis').Command | undefined} command
 * @param {() => void} send
 */
function runReplay (command, send) {
  const previousCommand = resendingCommand
  resendingCommand = command
  replayDepth++
  try {
    return send()
  } finally {
    replayDepth--
    resendingCommand = previousCommand
  }
}

/** @param {typeof import('ioredis/built/cluster/DelayQueue').default} DelayQueue */
function wrapDelayQueue (DelayQueue) {
  // Native queues retain callbacks, so the callback must be replaced before enqueueing.
  shimmer.wrap(DelayQueue.prototype, 'push', push => function (bucket, item, options) {
    if (replayDepth === 0) return push.call(this, bucket, item, options)
    const command = resendingCommand
    if (command) {
      replayCommands ??= new WeakSet()
      replayCommands.add(command)
    }
    return push.call(this, bucket, () => runReplay(command, item), options)
  })
  return DelayQueue
}

/** @param {typeof import('ioredis').Cluster} Cluster */
function wrapCluster (Cluster) {
  // runReplay must invoke the native drain inside its synchronous try/finally scope.
  shimmer.wrap(Cluster.prototype, 'executeOfflineCommands', execute => function () {
    if (!startCh.hasSubscribers || this.offlineQueue.length === 0) return execute.apply(this, arguments)
    return runReplay(resendingCommand, () => execute.apply(this, arguments))
  })
  return Cluster
}

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/cluster/index.js' }, wrapCluster)
addHook({ name: 'ioredis', versions: ['>=4'], file: 'built/cluster/index.js' }, exports => {
  wrapCluster(exports.default ?? exports)
  return exports
})

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/cluster/delay_queue.js' }, wrapDelayQueue)
addHook({ name: 'ioredis', versions: ['>=4'], file: 'built/cluster/DelayQueue.js' }, exports => {
  wrapDelayQueue(exports.default)
  return exports
})

addHook({ name: 'ioredis', versions: ['>=6'], file: 'built/himport/HimportCoordinator.js' }, exports => {
  shimmer.wrap(exports, 'interceptHimportCommand', intercept => function (redis, command, ready, resumeSend) {
    if (!startCh.hasSubscribers) return intercept.apply(this, arguments)
    return intercept.call(this, redis, command, ready, () => runReplay(command, resumeSend))
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
