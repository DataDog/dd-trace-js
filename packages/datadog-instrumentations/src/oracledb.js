'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startChannel = channel('apm:oracledb:query:start')
const errorChannel = channel('apm:oracledb:query:error')
const finishChannel = channel('apm:oracledb:query:finish')

function finish (err) {
  if (err) {
    errorChannel.publish(err)
  }
  finishChannel.publish()
}

addHook({ name: 'oracledb', versions: ['>=5'] }, oracledb => {
  shimmer.wrap(oracledb.Connection.prototype, 'execute', execute => {
    return function wrappedExecute (dbQuery, ...args) {
      if (!startChannel.hasSubscribers) {
        return execute.apply(this, arguments)
      }

      if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {
        const cb = arguments[arguments.length - 1]
        const outerAr = new AsyncResource('apm:oracledb:outer-scope')
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function wrappedCb (err, result) {
          finish(err)
          return outerAr.runInAsyncScope(() => cb.apply(this, arguments))
        })
      }

      return new AsyncResource('apm:oracledb:inner-scope').runInAsyncScope(() => {
        startChannel.publish({
          query: dbQuery,
          connAttrs: {
            dbInstance: this.serviceName,
            dbRemoteAddress: this.remoteAddress,
          }
        })
        try {
          let result = execute.apply(this, arguments)

          if (typeof result?.then === 'function') {
            result = result.then(
              x => {
                finish()
                return x
              },
              e => {
                finish(e)
                throw e
              }
            )
          }

          return result
        } catch (err) {
          errorChannel.publish(err)
          throw err
        }
      })
    }
  })
  return oracledb
})
