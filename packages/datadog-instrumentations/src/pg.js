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

const startPoolQueryCh = channel('datadog:pg:pool:query:start')
const finishPoolQueryCh = channel('datadog:pg:pool:query:finish')

addHook({ name: 'pg', versions: ['>=8.0.3'] }, pg => {
  shimmer.wrap(pg.Client.prototype, 'query', query => wrapQuery(query))
  shimmer.wrap(pg.Pool.prototype, 'query', query => wrapPoolQuery(query))
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

    const pgQuery = arguments[0] && typeof arguments[0] === 'object'
      ? arguments[0]
      : { text: arguments[0] }

    const textProp = Object.getOwnPropertyDescriptor(pgQuery, 'text')

    // Only alter `text` property if safe to do so.
    if (!textProp || textProp.configurable) {
      const originalText = pgQuery.text

      Object.defineProperty(pgQuery, 'text', {
        get () {
          return this?.__ddInjectableQuery || originalText
        }
      })
    }

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({
        params: this.connectionParameters,
        query: pgQuery,
        processId
      })

      arguments[0] = pgQuery

      const finish = asyncResource.bind(function (error) {
        if (error) {
          errorCh.publish(error)
        }
        finishCh.publish()
      })

      const retval = query.apply(this, arguments)
      const queryQueue = this.queryQueue || this._queryQueue
      const activeQuery = this.activeQuery || this._activeQuery

      const newQuery = queryQueue[queryQueue.length - 1] || activeQuery

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

function wrapPoolQuery (query) {
  return function () {
    if (!startPoolQueryCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const pgQuery = arguments[0] && typeof arguments[0] === 'object' ? arguments[0] : { text: arguments[0] }

    return asyncResource.runInAsyncScope(() => {
      startPoolQueryCh.publish({
        query: pgQuery
      })

      const finish = asyncResource.bind(function () {
        finishPoolQueryCh.publish()
      })

      const cb = arguments[arguments.length - 1]
      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrap(cb, function () {
          finish()
          return cb.apply(this, arguments)
        })
      }

      const retval = query.apply(this, arguments)

      if (retval && retval.then) {
        retval.then(() => {
          finish()
        }).catch(() => {
          finish()
        })
      }

      return retval
    })
  }
}
