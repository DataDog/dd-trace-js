'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:redis:command:start')
const finishCh = channel('apm:redis:command:finish')
const errorCh = channel('apm:redis:command:error')

let createClientUrl
let createClientName
const instanceInfo = new WeakMap()
const connectionInfoCache = new WeakMap()

function wrapAddCommand (addCommand) {
  return function (command) {
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const ctx = getStartCtx(this, command[0], command, 1)
    return startCh.runStores(ctx, () => {
      const res = addCommand.apply(this, arguments)

      res.then(() => finish(ctx), err => finish(ctx, err))

      return res
    })
  }
}

function wrapCommandQueueClass (cls) {
  return class RedisCommandQueue extends cls {
    constructor (...args) {
      super(...args)
      let url = { host: 'localhost', port: 6379 }
      if (createClientUrl) {
        try {
          const parsed = new URL(createClientUrl)
          url = { host: parsed.hostname, port: Number(parsed.port) || 6379 }
        } catch {
          // ignore
        }
      }
      instanceInfo.set(this, { connectionName: createClientName, url })
    }
  }
}

function wrapCreateClient (request) {
  return function (opts) {
    createClientUrl = opts && opts.url
    createClientName = opts && opts.name
    const ret = request.apply(this, arguments)
    createClientUrl = undefined
    createClientName = undefined
    return ret
  }
}

addHook({ name: '@node-redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1'] }, redis => {
  redis.default = wrapCommandQueueClass(redis.default)
  shimmer.wrap(redis.default.prototype, 'addCommand', wrapAddCommand)
  return redis
})

addHook({ name: '@node-redis/client', file: 'dist/lib/client/index.js', versions: ['>=1'] }, redis => {
  shimmer.wrap(redis.default, 'create', wrapCreateClient)
  return redis
})

addHook({ name: '@redis/client', file: 'dist/lib/client/index.js', versions: ['>=1.1'] }, redis => {
  shimmer.wrap(redis.default, 'create', wrapCreateClient)
  return redis
})

addHook({ name: '@redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1.1'] }, redis => {
  redis.default = wrapCommandQueueClass(redis.default)
  shimmer.wrap(redis.default.prototype, 'addCommand', wrapAddCommand)
  return redis
})

addHook({ name: 'redis', versions: ['>=2.6 <4'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', internalSendCommand => function (options) {
    if (!startCh.hasSubscribers || !options.callback) return internalSendCommand.apply(this, arguments)

    const ctx = getStartCtx(this, options.command, options.args)
    return startCh.runStores(ctx, () => {
      options.callback = wrapCallback(ctx, options.callback)

      try {
        return internalSendCommand.apply(this, arguments)
      } catch (err) {
        errorCh.publish(err)

        throw err
      }
    })
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=0.12 <2.6'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'send_command', sendCommand => function (command, args, callback) {
    if (!startCh.hasSubscribers) {
      return sendCommand.apply(this, arguments)
    }

    const ctx = getStartCtx(this, command, args)
    return startCh.runStores(ctx, () => {
      if (typeof callback === 'function') {
        arguments[2] = wrapCallback(ctx, callback)
      } else if (Array.isArray(args) && typeof args.at(-1) === 'function') {
        args[args.length - 1] = wrapCallback(ctx, args.at(-1))
      } else {
        arguments[2] = wrapCallback(ctx)
      }

      try {
        return sendCommand.apply(this, arguments)
      } catch (err) {
        ctx.error = err
        errorCh.publish(ctx)

        throw err
      }
    })
  })
  return redis
})

function getStartCtx (client, command, args, argsStartIndex) {
  let cached = connectionInfoCache.get(client)
  if (cached === undefined) {
    const info = instanceInfo.get(client)
    cached = {
      connectionOptions:
        client.connection_options || client.connection_option || client.connectionOption || info?.url,
      connectionName: info?.connectionName,
    }
    connectionInfoCache.set(client, cached)
  }

  return {
    command,
    args,
    argsStartIndex,
    connectionOptions: cached.connectionOptions,
    connectionName: cached.connectionName,
  }
}

/**
 * @param {Record<string, unknown> & { error?: Error }} ctx
 * @param {Function} [callback]
 */
function wrapCallback (ctx, callback) {
  if (typeof callback !== 'function') return callback
  return function (err) {
    return finish(ctx, err, callback, this, arguments)
  }
}

/**
 * @param {Record<string, unknown> & { error?: Error }} ctx
 * @param {Error} [error]
 * @param {Function} [callback]
 * @param {object} [thisArg]
 * @param {Iterable<unknown>} [args]
 */
function finish (ctx, error, callback, thisArg, args) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  if (callback) {
    return finishCh.runStores(
      ctx,
      /** @type {Parameters<typeof finishCh.runStores>[1]} */ (callback),
      thisArg,
      ...(/** @type {Iterable<unknown>} */ (args))
    )
  }
  return finishCh.publish(ctx)
}
