'use strict'

const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')

function wrapCommandStart (start) {
  return function () {
    if (!startCh.hasSubscribers) return start.apply(this, arguments)

    const callbackResource = new AsyncResource('bound-anonymous-fn')

    const resolve = callbackResource.bind(this.resolve)
    const reject = callbackResource.bind(this.reject)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    shimmer.wrap(this, 'resolve', function wrapResolve () {
      return function () {
        asyncResource.runInAsyncScope(() => {
          finishCh.publish()
        })

        return resolve.apply(this, arguments)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject () {
      return function (error) {
        asyncResource.runInAsyncScope(() => {
          errorCh.publish(error)
          finishCh.publish()
        })

        return reject.apply(this, arguments)
      }
    })

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ sql: this.sql, conf: this.opts })
      return start.apply(this, arguments)
    })
  }
}

const name = 'mariadb'
const versions = ['>=2.0.3']

addHook({ name, file: 'lib/cmd/query.js', versions }, (Query) => {
  shimmer.wrap(Query.prototype, 'start', wrapCommandStart)

  return Query
})

addHook({ name, file: 'lib/cmd/execute.js', versions }, (Query) => {
  shimmer.wrap(Query.prototype, 'start', wrapCommandStart)

  return Query
})
