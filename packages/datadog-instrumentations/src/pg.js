'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:pg:query:start')
const finishCh = channel('apm:pg:query:finish')
const errorCh = channel('apm:pg:query:error')

addHook({ name: 'pg', versions: ['>=8.0.3'] }, pg => {
  shimmer.wrap(pg.Client.prototype, 'query', query => wrapQuery(query))
  return pg
})

addHook({ name: 'pg', file: 'lib/native/index.js', versions: ['>=8.0.3'] }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

function wrapQuery (query) {
  return function () {
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    const processId = this.processID

    const pgQuery = arguments[0] && typeof arguments[0] === 'object' ? arguments[0] : { text: arguments[0] }

    // shallow clone the existing query to swap out .text field
    let newQuery = { ...pgQuery }

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({
        params: this.connectionParameters,
        query: newQuery,
        processId
      })

      arguments[0] = newQuery

      const finish = asyncResource.bind(function (error) {
        if (error) {
          errorCh.publish(error)
        }
        finishCh.publish()
      })

      const retval = query.apply(this, arguments)
      const queryQueue = this.queryQueue || this._queryQueue
      const activeQuery = this.activeQuery || this._activeQuery

      newQuery = queryQueue[queryQueue.length - 1] || activeQuery

      if (!newQuery) {
        return retval
      }

      if (newQuery.callback) {
        const originalCallback = callbackResource.bind(newQuery.callback)
        newQuery.callback = function (err, res) {
          finish(err)
          return originalCallback.apply(this, arguments)
        }
      } else if (newQuery.once) {
        newQuery
          .once('error', finish)
          .once('end', () => finish())
      } else {
        newQuery.then(() => finish(), finish)
      }

      try {
        return retval
      } catch (err) {
        errorCh.publish(err)
      }
    })
  }
}
