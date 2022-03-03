'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:redis:command:start')
const asyncEndCh = channel('apm:redis:command:async-end')
const endCh = channel('apm:redis:command:end')
const errorCh = channel('apm:redis:command:error')

addHook({ name: '@node-redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1'] }, redis => {
  shimmer.wrap(redis.default.prototype, 'addCommand', addCommand => function (command) {
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const name = command[0]
    const args = command.slice(1)

    start(this, name, args)

    const res = addCommand.apply(this, arguments)
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const onResolve = asyncResource.bind(() => finish(asyncEndCh, errorCh))
    const onReject = asyncResource.bind(err => finish(asyncEndCh, errorCh, err))

    res.then(onResolve, onReject)
    endCh.publish(undefined)
    return res
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=2.6 <4'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', internalSendCommand => function (options) {
    if (!startCh.hasSubscribers) return internalSendCommand.apply(this, arguments)

    if (!options.callback) return internalSendCommand.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const cb = asyncResource.bind(options.callback)

    start(this, options.command, options.args)

    options.callback = AsyncResource.bind(wrapCallback(asyncEndCh, errorCh, cb))

    try {
      return internalSendCommand.apply(this, arguments)
    } catch (err) {
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=0.12 <2.6'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'send_command', sendCommand => function (command, args, callback) {
    if (!startCh.hasSubscribers) {
      return sendCommand.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    start(this, command, args)

    if (typeof callback === 'function') {
      const cb = asyncResource.bind(callback)
      arguments[2] = AsyncResource.bind(wrapCallback(asyncEndCh, errorCh, cb))
    } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
      const cb = asyncResource.bind(args[args.length - 1])
      args[args.length - 1] = AsyncResource.bind(wrapCallback(asyncEndCh, errorCh, cb))
    } else {
      arguments[2] = AsyncResource.bind(wrapCallback(asyncEndCh, errorCh))
    }

    try {
      return sendCommand.apply(this, arguments)
    } catch (err) {
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

function start (client, command, args) {
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || client.connectionOption || {}
  startCh.publish({ db, command, args, connectionOptions })
}

function wrapCallback (asyncEndCh, errorCh, callback) {
  return function (err) {
    finish(asyncEndCh, errorCh, err)
    if (callback) {
      return callback.apply(this, arguments)
    }
  }
}

function finish (asyncEndCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}
