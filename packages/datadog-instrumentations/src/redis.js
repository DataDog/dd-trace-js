'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const tx = require('./helpers/tx')

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

    startSpan(this, name, args)

    return wrapReturn(tx.wrap(asyncEndCh, errorCh, addCommand.apply(this, arguments)))
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=2.6 <4'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', internalSendCommand => function (options) {
    if (!startCh.hasSubscribers) return internalSendCommand.apply(this, arguments)

    if (!options.callback) return internalSendCommand.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const cb = asyncResource.bind(options.callback)

    startSpan(this, options.command, options.args)

    options.callback = AsyncResource.bind(tx.wrap(asyncEndCh, errorCh, cb))

    return wrapReturn(internalSendCommand.apply(this, arguments))
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=0.12 <2.6'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'send_command', sendCommand => function (command, args, callback) {
    if (!startCh.hasSubscribers) {
      return sendCommand.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    startSpan(this, command, args)

    if (typeof callback === 'function') {
      const cb = asyncResource.bind(callback)
      arguments[2] = AsyncResource.bind(tx.wrap(asyncEndCh, errorCh, cb))
    } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
      const cb = asyncResource.bind(args[args.length - 1])
      args[args.length - 1] = AsyncResource.bind(tx.wrap(asyncEndCh, errorCh, cb))
    } else {
      arguments[2] = AsyncResource.bind(tx.wrap(asyncEndCh, errorCh))
    }

    return wrapReturn(sendCommand.apply(this, arguments))
  })
  return redis
})

function startSpan (client, command, args) {
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || client.connectionOption || {}
  startCh.publish({ db, command, args, connectionOptions })
}

function wrapReturn (fn) {
  try {
    return fn
  } catch (err) {
    err.stack // trigger getting the stack at the original throwing point
    errorCh.publish(err)

    throw err
  } finally {
    endCh.publish(undefined)
  }
}
