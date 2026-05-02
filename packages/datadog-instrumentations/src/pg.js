'use strict'

const { errorMonitor } = require('node:events')

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:pg:query:start')
const finishCh = channel('apm:pg:query:finish')
const errorCh = channel('apm:pg:query:error')

const startPoolQueryCh = channel('datadog:pg:pool:query:start')
const finishPoolQueryCh = channel('datadog:pg:pool:query:finish')

addHook({ name: 'pg', versions: ['>=8.0.3'], file: 'lib/native/client.js' }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

addHook({ name: 'pg', versions: ['>=8.0.3'], file: 'lib/client.js' }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

addHook({ name: 'pg', versions: ['>=8.0.3'] }, pg => {
  shimmer.wrap(pg.Pool.prototype, 'query', query => wrapPoolQuery(query))
  return pg
})

function wrapQuery (query) {
  return function (...args) {
    if (!startCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const processId = this.processID

    const pgQuery = args[0] !== null && typeof args[0] === 'object'
      ? args[0]
      : { text: args[0] }

    const textPropObj = pgQuery.cursor ?? pgQuery
    const textProp = Object.getOwnPropertyDescriptor(textPropObj, 'text')
    const stream = typeof textPropObj.read === 'function'

    // Fast path: when the descriptor is a configurable, writable data property, the plugin can
    // overwrite `text` with the DBM-annotated SQL directly — no getter trampoline on every read.
    // The pg / pg-cursor common shapes (`{ text: '...' }`, `client.query('text')`) hit this.
    // Accessor descriptors, missing own descriptors (where a prototype getter may apply), and
    // read-only data properties still go through `defineProperty(get)` so query objects exposing
    // `get text ()` keep working.
    let originalText
    let directAssign = false
    if (textProp?.configurable === true && textProp.writable === true) {
      originalText = textProp.value
      directAssign = true
    } else if (!textProp || textProp.configurable === true) {
      originalText = textPropObj.text

      Object.defineProperty(textPropObj, 'text', {
        configurable: true,
        enumerable: textProp ? textProp.enumerable : true,
        get () {
          return this?.__ddInjectableQuery || originalText
        },
      })
    }

    const abortController = new AbortController()
    const ctx = {
      params: this.connectionParameters,
      query: textPropObj,
      originalText,
      directAssign,
      processId,
      abortController,
      stream,
    }
    const finish = (error, res) => {
      if (error) {
        ctx.error = error
        errorCh.publish(ctx)
      }
      ctx.result = res?.rows
      return finishCh.publish(ctx)
    }
    return startCh.runStores(ctx, () => {
      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')

        // Based on: https://github.com/brianc/node-postgres/blob/54eb0fa216aaccd727765641e7d1cf5da2bc483d/packages/pg/lib/client.js#L510
        const reusingQuery = typeof pgQuery.submit === 'function'
        const callback = args[args.length - 1]

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

      args[0] = pgQuery

      const retval = query.apply(this, args)

      const deperecated = Object.hasOwn(this, '_activeQuery')
      const queryQueue = deperecated ? this._queryQueue : this.queryQueue
      const activeQuery = deperecated ? this._activeQuery : this.activeQuery

      const newQuery = queryQueue.at(-1) || activeQuery

      if (!newQuery) {
        return retval
      }

      if (newQuery.callback) {
        const originalCallback = newQuery.callback
        newQuery.callback = function (err, ...args) {
          finish(err, ...args)
          return finishCh.runStores(ctx, originalCallback, this, err, ...args)
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
      } catch (error) {
        ctx.error = error
        errorCh.publish(ctx)
      }
    })
  }
}
const finish = (ctx) => {
  finishPoolQueryCh.publish(ctx)
}
function wrapPoolQuery (query) {
  return function (...args) {
    if (!startPoolQueryCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const pgQuery = args[0] !== null && typeof args[0] === 'object' ? args[0] : { text: args[0] }
    const abortController = new AbortController()

    const ctx = { query: pgQuery, abortController }

    return startPoolQueryCh.runStores(ctx, () => {
      const cb = args[args.length - 1]

      if (abortController.signal.aborted) {
        const error = abortController.signal.reason || new Error('Aborted')
        finish(ctx)

        if (typeof cb === 'function') {
          cb(error)

          return
        }
        return Promise.reject(error)
      }

      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapFunction(cb, cb => function (...args) {
          finish(ctx)
          return cb.apply(this, args)
        })
      }

      const retval = query.apply(this, args)

      if (retval?.then) {
        retval.then(() => {
          finish(ctx)
        }).catch(() => {
          finish(ctx)
        })
      }

      return retval
    })
  }
}
