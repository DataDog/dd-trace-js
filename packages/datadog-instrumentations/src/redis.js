'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:redis:command:start')
const finishCh = channel('apm:redis:command:finish')
const errorCh = channel('apm:redis:command:error')

function wrapAddCommand (addCommand) {
  return function (command) {
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const name = command[0]
    const args = command.slice(1)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      start(this, name, args)

      const res = addCommand.apply(this, arguments)
      const onResolve = asyncResource.bind(() => finish(finishCh, errorCh))
      const onReject = asyncResource.bind(err => finish(finishCh, errorCh, err))

      res.then(onResolve, onReject)

      return res
    })
  }
}

addHook({ name: '@redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1.1'] }, redis => {
  shimmer.wrap(redis.default.prototype, 'addCommand', wrapAddCommand)
  return redis
})

addHook({ name: '@node-redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1'] }, redis => {
  shimmer.wrap(redis.default.prototype, 'addCommand', wrapAddCommand)
  return redis
})

addHook({ name: 'redis', versions: ['>=2.6 <4'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', internalSendCommand => function (options) {
    if (!startCh.hasSubscribers) return internalSendCommand.apply(this, arguments)

    if (!options.callback) return internalSendCommand.apply(this, arguments)

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const cb = callbackResource.bind(options.callback)

    return asyncResource.runInAsyncScope(() => {
      start(this, options.command, options.args)

      options.callback = asyncResource.bind(wrapCallback(finishCh, errorCh, cb))

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

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      start(this, command, args)

      if (typeof callback === 'function') {
        const cb = callbackResource.bind(callback)
        arguments[2] = asyncResource.bind(wrapCallback(finishCh, errorCh, cb))
      } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
        const cb = callbackResource.bind(args[args.length - 1])
        args[args.length - 1] = asyncResource.bind(wrapCallback(finishCh, errorCh, cb))
      } else {
        arguments[2] = asyncResource.bind(wrapCallback(finishCh, errorCh))
      }

      try {
        return sendCommand.apply(this, arguments)
      } catch (err) {
        errorCh.publish(err)

        throw err
      }
    })
  })
  return redis
})

function start (client, command, args) {
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || client.connectionOption || {}
  startCh.publish({ db, command, args, connectionOptions })
}

function wrapCallback (finishCh, errorCh, callback) {
  return function (err) {
    finish(finishCh, errorCh, err)
    if (callback) {
      return callback.apply(this, arguments)
    }
  }
}

function finish (finishCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  finishCh.publish()
}
