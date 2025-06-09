'use strict'

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const finishCh = channel('apm:mysql:query:finish')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function () {
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const sql = arguments[0].sql || arguments[0]
    const conf = this.config
    const ctx = { sql, conf }

    return startCh.runStores(ctx, () => {
      if (arguments[0].sql) {
        arguments[0].sql = ctx.sql
      } else {
        arguments[0] = ctx.sql
      }

      try {
        const res = query.apply(this, arguments)

        if (res._callback) {
          const cb = res._callback
          res._callback = shimmer.wrapFunction(cb, cb => function (error, result) {
            if (error) {
              ctx.error = error
              errorCh.publish(ctx)
            }
            ctx.result = result

            return finishCh.runStores(ctx, cb, this, error, result)
          })
        } else {
          res.on('end', () => finishCh.publish(ctx))
        }

        return res
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
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
    arguments[0] = function () {
      return connectionFinishCh.runStores(ctx, cb, this, ...arguments)
    }

    const ctx = {}

    connectionStartCh.publish(ctx)

    return getConnection.apply(this, arguments)
  })

  shimmer.wrap(Pool.prototype, 'query', query => function () {
    if (!startPoolQueryCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const sql = arguments[0].sql || arguments[0]
    const ctx = { sql }
    const finish = () => finishPoolQueryCh.publish(ctx)

    return startPoolQueryCh.runStores(ctx, () => {
      const cb = arguments[arguments.length - 1]
      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function () {
          return finishPoolQueryCh.runStores(ctx, cb, this, ...arguments)
        })
      }

      const retval = query.apply(this, arguments)

      if (retval && retval.then) {
        retval.then(finish).catch(finish)
      }

      return retval
    })
  })

  return Pool
})
