'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:redis:command:start')
const finishCh = channel('apm:redis:command:finish')
const errorCh = channel('apm:redis:command:error')

let createClientUrl

function wrapAddCommand (addCommand) {
  return function (command) {
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const name = command[0]
    const args = command.slice(1)

    const ctx = getStartCtx(this, name, args, this._url)
    return startCh.runStores(ctx, () => {
      const res = addCommand.apply(this, arguments)

      res.then(() => finish(finishCh, errorCh, ctx), err => finish(finishCh, errorCh, ctx, err))

      return res
    })
  }
}

function wrapCommandQueueClass (cls) {
  const ret = class RedisCommandQueue extends cls {
    constructor (...args) {
      super(...args)
      if (createClientUrl) {
        try {
          const parsed = new URL(createClientUrl)
          if (parsed) {
            this._url = { host: parsed.hostname, port: Number(parsed.port) || 6379 }
          }
        } catch {
          // ignore
        }
      }
      this._url = this._url || { host: 'localhost', port: 6379 }
    }
  }
  return ret
}

function wrapCreateClient (request) {
  return function (opts) {
    createClientUrl = opts && opts.url
    const ret = request.apply(this, arguments)
    createClientUrl = undefined
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
    if (!startCh.hasSubscribers) return internalSendCommand.apply(this, arguments)

    if (!options.callback) return internalSendCommand.apply(this, arguments)

    const ctx = getStartCtx(this, options.command, options.args)
    return startCh.runStores(ctx, () => {
      options.callback = wrapCallback(finishCh, errorCh, ctx, options.callback)

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
        arguments[2] = wrapCallback(finishCh, errorCh, ctx, callback)
      } else if (Array.isArray(args) && typeof args.at(-1) === 'function') {
        args[args.length - 1] = wrapCallback(finishCh, errorCh, ctx, args.at(-1))
      } else {
        arguments[2] = wrapCallback(finishCh, errorCh, ctx)
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

function getStartCtx (client, command, args, url = {}) {
  return {
    db: client.selected_db,
    command,
    args,
    connectionOptions: client.connection_options || client.connection_option || client.connectionOption || url
  }
}

function wrapCallback (finishCh, errorCh, ctx, callback) {
  return shimmer.wrapFunction(callback, callback => function (err) {
    return finish(finishCh, errorCh, ctx, err, callback, this, arguments)
  })
}

function finish (finishCh, errorCh, ctx, error, callback, thisArg, args) {
  if (error) {
    ctx.error = error
    errorCh.publish(ctx)
  }
  if (callback) {
    return finishCh.runStores(ctx, callback, thisArg, ...args)
  }
  finishCh.publish(ctx)
}
