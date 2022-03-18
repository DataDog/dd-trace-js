'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:pg:query:start')
const asyncEndCh = channel('apm:pg:query:async-end')
const endCh = channel('apm:pg:query:end')
const errorCh = channel('apm:pg:query:error')

addHook({ name: 'pg', versions: ['>=4'] }, pg => {
  shimmer.wrap(pg.Client.prototype, 'query', query => wrapQuery(query))
  return pg
})

addHook({ name: 'pg', file: 'lib/native/index.js', versions: ['>=4'] }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

function wrapQuery (query) {
  return function () {
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const retval = query.apply(this, arguments)

    const queryQueue = this.queryQueue || this._queryQueue
    const activeQuery = this.activeQuery || this._activeQuery
    const pgQuery = queryQueue[queryQueue.length - 1] || activeQuery

    if (!pgQuery) {
      return retval
    }
    const statement = pgQuery.text

    startCh.publish({ params: this.connectionParameters, statement })

    const finish = AsyncResource.bind(function (error) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(undefined)
    })

    if (pgQuery.callback) {
      const originalCallback = asyncResource.bind(pgQuery.callback)
      pgQuery.callback = function (err, res) {
        finish(err)
        return originalCallback.apply(this, arguments)
      }
    } else if (pgQuery.once) {
      pgQuery
        .once('error', finish)
        .once('end', () => finish())
    } else {
      pgQuery.then(() => finish(), finish)
    }

    try {
      return retval
    } catch (err) {
      errorCh.publish(err)
    } finally {
      endCh.publish(undefined)
    }
  }
}
