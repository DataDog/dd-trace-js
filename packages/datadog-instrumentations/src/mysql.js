'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const finishCh = channel('apm:mysql:query:finish')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function (...args) {
    if (!startCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const sql = args[0].sql || args[0]
    const conf = this.config
    const ctx = { sql, conf }

    return startCh.runStores(ctx, () => {
      if (args[0].sql) {
        args[0].sql = ctx.sql
      } else {
        args[0] = ctx.sql
      }

      try {
        const res = query.apply(this, args)

        if (res._callback) {
          const cb = res._callback
          res._callback = shimmer.wrapCallback(cb, cb => function (error, result) {
            if (error) {
              ctx.error = error
              errorCh.publish(ctx)
            }
            ctx.result = result

            return finishCh.runStores(ctx, cb, this, error, result)
          })
        } else {
          res.once('end', () => finishCh.publish(ctx))
        }

        return res
      } catch (err) {
        void err.stack // trigger getting the stack at the original throwing point
        ctx.error = err
        errorCh.publish(ctx)

        throw err
      }
    })
  })

  return Connection
})

addHook({ name: 'mysql', file: 'lib/Pool.js', versions: ['>=2'] }, Pool => {
  const connectionStartCh = channel('apm:mysql:connection:start')
  const connectionFinishCh = channel('apm:mysql:connection:finish')
  const startPoolQueryCh = channel('datadog:mysql:pool:query:start')
  const finishPoolQueryCh = channel('datadog:mysql:pool:query:finish')

  shimmer.wrap(Pool.prototype, 'getConnection', getConnection => function (cb) {
    arguments[0] = function (...args) {
      return connectionFinishCh.runStores(ctx, cb, this, ...args)
    }

    const ctx = {}

    connectionStartCh.publish(ctx)

    return getConnection.apply(this, arguments)
  })

  shimmer.wrap(Pool.prototype, 'query', query => function (...args) {
    if (!startPoolQueryCh.hasSubscribers) {
      return query.apply(this, args)
    }

    const sql = args[0].sql || args[0]
    const ctx = { sql }
    const finish = () => finishPoolQueryCh.publish(ctx)

    return startPoolQueryCh.runStores(ctx, () => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapCallback(cb, cb => function (...args) {
          return finishPoolQueryCh.runStores(ctx, cb, this, ...args)
        })
      }

      const retval = query.apply(this, args)

      if (retval && retval.then) {
        retval.then(finish).catch(finish)
      }

      return retval
    })
  })

  return Pool
})
