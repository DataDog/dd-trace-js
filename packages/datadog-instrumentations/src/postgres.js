'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:postgres:query:start')
const finishCh = channel('apm:postgres:query:finish')
const errorCh = channel('apm:postgres:query:error')

const instrumentedSymbol = Symbol('dd-trace.instrumented')
const optionsSymbol = Symbol('dd-trace.options')

// Hook the main postgres module to capture connection options
addHook({ name: 'postgres', versions: ['>=3.4.5'] }, (postgres) => {
  return shimmer.wrapFunction(postgres, postgres => function () {
    const sql = postgres.apply(this, arguments)

    // Store connection options on the sql function for later access
    if (sql && sql.options) {
      sql[optionsSymbol] = {
        host: Array.isArray(sql.options.host) ? sql.options.host[0] : sql.options.host,
        port: Array.isArray(sql.options.port) ? sql.options.port[0] : sql.options.port,
        database: sql.options.database,
        user: sql.options.user
      }

      // Wrap the sql template function to pass options to queries
      const originalSql = sql
      const wrappedSql = function (strings, ...args) {
        const query = originalSql(strings, ...args)
        if (query && query.then) {
          // It's a Query object
          query[optionsSymbol] = sql[optionsSymbol]
        }
        return query
      }

      // Copy all properties from original sql to wrapped
      Object.setPrototypeOf(wrappedSql, Object.getPrototypeOf(sql))
      for (const key of Object.keys(sql)) {
        wrappedSql[key] = sql[key]
      }
      wrappedSql[optionsSymbol] = sql[optionsSymbol]
      wrappedSql.options = sql.options

      return wrappedSql
    }

    return sql
  })
})

addHook({ name: 'postgres', versions: ['>=3.4.5'], file: 'cjs/src/query.js' }, (exports) => {
  const Query = exports.Query

  shimmer.wrap(Query.prototype, 'handle', handle => function () {
    if (!startCh.hasSubscribers) {
      return handle.apply(this, arguments)
    }

    const query = this

    if (query[instrumentedSymbol]) {
      return handle.apply(this, arguments)
    }
    query[instrumentedSymbol] = true

    const queryText = getQueryText(query)

    // Get connection options if available
    const connectionOptions = query[optionsSymbol] || {}

    const ctx = {
      query: queryText,
      queryObject: query,
      params: connectionOptions
    }

    return startCh.runStores(ctx, () => {
      // Check if the plugin has set an injectable query with DBM comment
      if (ctx.injectableQuery && query.strings) {
        // Inject the DBM comment into the first string of the query
        if (Array.isArray(query.strings.raw)) {
          const newStrings = [...query.strings]
          const newRaw = [...query.strings.raw]
          newRaw[0] = ctx.injectableQuery
          newStrings[0] = ctx.injectableQuery
          newStrings.raw = newRaw
          query.strings = newStrings
        } else if (Array.isArray(query.strings)) {
          const newStrings = [...query.strings]
          newStrings[0] = ctx.injectableQuery
          query.strings = newStrings
        }
      }

      const promise = handle.apply(this, arguments)

      Promise.prototype.then.call(query,
        (result) => {
          ctx.result = result
          finishCh.publish(ctx)
        },
        (error) => {
          ctx.error = error
          errorCh.publish(ctx)
          finishCh.publish(ctx)
        }
      )

      return promise
    })
  })

  return exports
})

function getQueryText (query) {
  if (query.strings && Array.isArray(query.strings.raw)) {
    return query.strings.raw.join('$?')
  }
  if (query.strings && query.strings.length > 0) {
    return query.strings.join('$?')
  }
  return ''
}
