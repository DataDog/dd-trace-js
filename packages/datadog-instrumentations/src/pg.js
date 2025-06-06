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

const { errorMonitor } = require('node:events')

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

    const pgQuery = arguments[0] !== null && typeof arguments[0] === 'object'
      ? arguments[0]
      : { text: arguments[0] }

    const textPropObj = pgQuery.cursor ?? pgQuery
    const textProp = Object.getOwnPropertyDescriptor(textPropObj, 'text')
    const stream = typeof textPropObj.read === 'function'

    // Only alter `text` property if safe to do so. Initially, it's a property, not a getter.
    if (!textProp || textProp.configurable) {
      const originalText = textPropObj.text

      Object.defineProperty(textPropObj, 'text', {
        get () {
          return this?.__ddInjectableQuery || originalText
        }
      })
    }

    return asyncResource.runInAsyncScope(() => {
      const abortController = new AbortController()

      startCh.publish({
        params: this.connectionParameters,
        query: textPropObj,
        processId,
        abortController,
        stream
      })

      const finish = asyncResource.bind(function (error, res) {
        if (error) {
          errorCh.publish(error)
        }
        finishCh.publish({ result: res?.rows })
      })

      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')

        // Based on: https://github.com/brianc/node-postgres/blob/54eb0fa216aaccd727765641e7d1cf5da2bc483d/packages/pg/lib/client.js#L510
        const reusingQuery = typeof pgQuery.submit === 'function'
        const callback = arguments[arguments.length - 1]

        finish(error)

        if (reusingQuery) {
          if (!pgQuery.callback && typeof callback === 'function') {
            pgQuery.callback = callback
          }

          if (pgQuery.callback) {
            pgQuery.callback(error)
          } else {
            process.nextTick(() => {
              pgQuery.emit('error', error)
            })
          }

          return pgQuery
        }

        if (typeof callback === 'function') {
          callback(error)

          return
        }

        return Promise.reject(error)
      }

      arguments[0] = pgQuery

      const retval = query.apply(this, arguments)
      const queryQueue = this.queryQueue || this._queryQueue
      const activeQuery = this.activeQuery || this._activeQuery

      const newQuery = queryQueue.at(-1) || activeQuery

      if (!newQuery) {
        return retval
      }

      if (newQuery.callback) {
        const originalCallback = callbackResource.bind(newQuery.callback)
        newQuery.callback = function (err, res) {
          finish(err, res)
          return originalCallback.apply(this, arguments)
        }
      } else if (newQuery.once) {
        newQuery
          .once(errorMonitor, finish)
          .once('end', (res) => finish(null, res))
      } else {
        // TODO: This code is never reached in our tests.
        // Internally, pg always uses callbacks or streams, even for promise based queries.
        // Investigate if this code should just be removed.
        newQuery.then((res) => finish(null, res), finish)
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

    const pgQuery = arguments[0] !== null && typeof arguments[0] === 'object' ? arguments[0] : { text: arguments[0] }

    return asyncResource.runInAsyncScope(() => {
      const abortController = new AbortController()

      startPoolQueryCh.publish({
        query: pgQuery,
        abortController
      })

      const finish = asyncResource.bind(function () {
        finishPoolQueryCh.publish()
      })

      const cb = arguments[arguments.length - 1]

      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')
        finish()

        if (typeof cb === 'function') {
          cb(error)

          return
        }
        return Promise.reject(error)
      }

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function () {
          finish()
          return cb.apply(this, arguments)
        })
      }

      const retval = query.apply(this, arguments)

      if (retval?.then) {
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
