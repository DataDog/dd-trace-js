'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:ioredis:command:start')
const asyncEndCh = channel('apm:ioredis:command:async-end')
const endCh = channel('apm:ioredis:command:end')
const errorCh = channel('apm:ioredis:command:error')

addHook({ name: 'ioredis', versions: ['>=2'] }, Redis => {
  shimmer.wrap(Redis.prototype, 'sendCommand', sendCommand => function (command, stream) {
    if (!startCh.hasSubscribers) return sendCommand.apply(this, arguments)

    if (!command || !command.promise) return sendCommand.apply(this, arguments)

    const options = this.options || {}
    const connectionName = this.options.connectionName
    const db = options.db
    const connectionOptions = { host: options.host, port: options.port }
    startCh.publish({ db, command: command.name, args: command.args, connectionOptions, connectionName })

    try {
      wrap(asyncEndCh, errorCh, command.promise)

      return sendCommand.apply(this, arguments)
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return Redis
})

function wrap (asyncEndCh, errorCh, done) {
  if (typeof done === 'function' || !done) {
    return wrapCallback(asyncEndCh, errorCh, done)
  } else if (isPromise(done)) {
    done.then(
      () => finish(asyncEndCh, errorCh),
      err => finish(asyncEndCh, errorCh, err)
    )
    return done
  } else if (done && done.length) {
    const lastIndex = done.length - 1
    const callback = done[lastIndex]

    if (typeof callback === 'function') {
      done[lastIndex] = wrapCallback(asyncEndCh, errorCh, done[lastIndex])
    }

    return done
  }
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

function isPromise (obj) {
  return isObject(obj) && typeof obj.then === 'function'
}

function isObject (obj) {
  return typeof obj === 'object' && obj !== null
}
