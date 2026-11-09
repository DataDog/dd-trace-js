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
let replayPromises
let replaying = false

function wrapRedis (Redis) {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers || !command?.promise || (replaying && replayPromises.has(command.promise))) {
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
      return sendCommand.call(this, command, stream)
    })
  })

  const errorHandler = Redis.prototype.handleReconnection ? 'handleReconnection' : 'returnError'
  shimmer.wrap(Redis.prototype, errorHandler, handleReconnection => function (error, item) {
    if (startCh.hasSubscribers) {
      const command = item ? item.command : this.commandQueue.get(0).command
      trackReplay(command.promise)
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
  shimmer.wrap(Redis.prototype, 'setStatus', setStatus => function (status) {
    if (status === 'ready' && startCh.hasSubscribers) {
      trackQueue(this.offlineQueue)
      if (this.options.autoResendUnfulfilledCommands) trackQueue(this.prevCommandQueue)
    }
    return setStatus.apply(this, arguments)
  })
  return Redis
}

/**
 * @param {import('denque')<{ command: import('ioredis').Command }> | undefined} queue
 */
function trackQueue (queue) {
  for (let i = 0; i < (queue?.length ?? 0); i++) {
    trackReplay(queue.get(i).command.promise)
  }
}

/** @param {import('ioredis').Command['promise']} promise */
function trackReplay (promise) {
  const promises = replayPromises ??= new WeakSet()
  promises.add(promise)
  if (!replaying) {
    replaying = true
    queueMicrotask(clearReplayScope)
  }
}

function clearReplayScope () {
  replaying = false
}

/** @param {((bucket: string) => void) | (() => void)} callback */
function wrapReplay (callback) {
  return function () {
    if (!replayPromises || !startCh.hasSubscribers) return callback.apply(this, arguments)
    const previous = replaying
    replaying = true
    try {
      return callback.apply(this, arguments)
    } finally {
      replaying = previous
    }
  }
}

/** @param {typeof import('ioredis/built/cluster/DelayQueue').default} DelayQueue */
function wrapDelayQueue (DelayQueue) {
  const execute = DelayQueue.prototype.execute ? 'execute' : '_execute'
  shimmer.wrap(DelayQueue.prototype, execute, wrapReplay)
  return DelayQueue
}

/** @param {typeof import('ioredis').Cluster} Cluster */
function wrapCluster (Cluster) {
  shimmer.wrap(Cluster.prototype, 'executeOfflineCommands', wrapReplay)
  return Cluster
}

addHook({ name: 'ioredis', versions: ['>=6'], file: 'built/himport/HimportCoordinator.js' }, exports => {
  shimmer.wrap(exports.default.prototype, 'allowNextSend', allowNextSend => function (redis, command) {
    if (startCh.hasSubscribers) trackReplay(command.promise)
    return allowNextSend.apply(this, arguments)
  })
  return exports
})

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/cluster/delay_queue.js' }, wrapDelayQueue)

addHook({ name: 'ioredis', versions: ['>=4'], file: 'built/cluster/DelayQueue.js' }, exports => {
  wrapDelayQueue(exports.default)
  return exports
})

addHook({ name: 'ioredis', versions: ['>=2 <4'], file: 'lib/cluster/index.js' }, wrapCluster)

addHook({ name: 'ioredis', versions: ['>=4'], file: 'built/cluster/index.js' }, exports => {
  wrapCluster(exports.default || exports)
  return exports
})

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
