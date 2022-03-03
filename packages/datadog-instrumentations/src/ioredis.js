'use strict'

const {
  channel,
  addHook,
  AsyncResource
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
    const connectionName = options.connectionName
    const db = options.db
    const connectionOptions = { host: options.host, port: options.port }

    startCh.publish({ db, command: command.name, args: command.args, connectionOptions, connectionName })

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const onResolve = asyncResource.bind(() => finish(asyncEndCh, errorCh))
    const onReject = asyncResource.bind(err => finish(asyncEndCh, errorCh, err))

    command.promise.then(onResolve, onReject)

    try {
      return sendCommand.apply(this, arguments)
    } catch (err) {
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return Redis
})

function finish (asyncEndCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}
