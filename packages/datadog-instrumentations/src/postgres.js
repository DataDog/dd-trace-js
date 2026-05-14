'use strict'

const { addHook, channel } = require('./helpers/instrument')

const startCh = channel('apm:pg:query:start')
const finishCh = channel('apm:pg:query:finish')
const errorCh = channel('apm:pg:query:error')

const wrappedClients = new WeakMap()
const wrappedUnsafe = new WeakMap()

addHook({ name: 'postgres', versions: ['>=3.0.0'] }, wrapPostgres)

function wrapPostgres (postgres) {
  if (typeof postgres !== 'function') return postgres

  return function wrappedPostgres (...args) {
    const sql = postgres.apply(this, args)
    return wrapClient(sql, extractConnectionParams(sql, args[0]))
  }
}

function wrapClient (sql, params) {
  if (typeof sql !== 'function') return sql

  const cached = wrappedClients.get(sql)
  if (cached) return cached

  const wrappedSql = new Proxy(sql, {
    apply (target, thisArg, args) {
      return traceQuery(target, thisArg, args, params, false)
    },
    get (target, property, receiver) {
      const value = Reflect.get(target, property, receiver)

      if (property !== 'unsafe' || typeof value !== 'function') {
        return value
      }

      const cachedUnsafe = wrappedUnsafe.get(value)
      if (cachedUnsafe) return cachedUnsafe

      const wrappedUnsafeMethod = function (...args) {
        return traceQuery(value, target, args, params, true)
      }

      wrappedUnsafe.set(value, wrappedUnsafeMethod)
      return wrappedUnsafeMethod
    },
  })

  wrappedClients.set(sql, wrappedSql)
  return wrappedSql
}

function traceQuery (queryFn, thisArg, args, params, isUnsafe) {
  if (!startCh.hasSubscribers) {
    return queryFn.apply(thisArg, args)
  }

  const queryText = getQueryText(args, isUnsafe)
  if (!queryText) {
    return queryFn.apply(thisArg, args)
  }

  const ctx = {
    params,
    query: { text: queryText },
    originalText: queryText,
  }

  return startCh.runStores(ctx, () => {
    if (isUnsafe && typeof ctx.injected === 'string') {
      args[0] = ctx.injected
      ctx.query.text = ctx.injected
    }

    try {
      const result = queryFn.apply(thisArg, args)

      if (result?.then) {
        return result.then((value) => {
          ctx.result = value
          finishCh.publish(ctx)
          return value
        }, (error) => {
          ctx.error = error
          errorCh.publish(ctx)
          finishCh.publish(ctx)
          throw error
        })
      }

      ctx.result = result
      finishCh.publish(ctx)
      return result
    } catch (error) {
      ctx.error = error
      errorCh.publish(ctx)
      finishCh.publish(ctx)
      throw error
    }
  })
}

function getQueryText (args, isUnsafe) {
  if (isUnsafe) {
    return typeof args[0] === 'string' ? args[0] : undefined
  }

  const [strings] = args
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    return undefined
  }

  let queryText = ''
  for (let i = 0; i < strings.length; i++) {
    queryText += strings[i]
    if (i < strings.length - 1) {
      queryText += `$${i + 1}`
    }
  }

  return queryText
}

function extractConnectionParams (sql, options) {
  const sqlOptions = sql?.options

  if (sqlOptions && typeof sqlOptions === 'object') {
    return {
      host: sqlOptions.host,
      port: sqlOptions.port,
      database: sqlOptions.database,
      user: sqlOptions.user ?? sqlOptions.username,
    }
  }

  if (typeof options === 'string') {
    try {
      const parsed = new URL(options)
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        database: parsed.pathname ? parsed.pathname.slice(1) : undefined,
        user: parsed.username || undefined,
      }
    } catch (_) {}
  }

  if (options && typeof options === 'object') {
    return {
      host: options.host,
      port: options.port,
      database: options.database ?? options.db,
      user: options.user ?? options.username,
    }
  }

  return {}
}

module.exports = { wrapPostgres }