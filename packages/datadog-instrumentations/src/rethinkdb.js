'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const startCh = channel('apm:rethinkdb:query:start')
const finishCh = channel('apm:rethinkdb:query:finish')
const errorCh = channel('apm:rethinkdb:query:error')

// Shimmer is required because we must wrap the `cb` argument to intercept
// query completion. Orchestrion's static AST rewriting cannot modify
// dynamically-passed callback arguments at call sites.
addHook({ name: 'rethinkdb', versions: ['>=2.3.2'], file: 'net.js' }, net => {
  shimmer.wrap(net.Connection.prototype, '_start', _start => function (term, cb, opts) {
    if (!startCh.hasSubscribers) {
      return _start.apply(this, arguments)
    }

    const ctx = {
      db: (opts && opts.db) || this.db,
      host: this.host,
      port: this.port,
      query: term.toString().replace(/^undefined\./, 'r.'),
    }

    return startCh.runStores(ctx, () => {
      if (typeof cb === 'function') {
        arguments[1] = shimmer.wrapCallback(cb, cb => function (err, result) {
          if (err) {
            ctx.error = err
            errorCh.publish(ctx)
          }
          ctx.result = result
          return finishCh.runStores(ctx, cb, this, err, result)
        })
      }

      try {
        return _start.apply(this, arguments)
      } catch (e) {
        ctx.error = e
        errorCh.publish(ctx)
        throw e
      }
    })
  })
  return net
})
