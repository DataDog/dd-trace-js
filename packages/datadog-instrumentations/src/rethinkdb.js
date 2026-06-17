'use strict'

// Shimmer required: rethinkdb's Connection class is defined via CoffeeScript prototypal
// inheritance (net.js), and the _start method is called from TermBase.prototype.run with a
// callback argument — orchestrion cannot handle the dynamic callback wrapping needed here.

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const startCh = channel('apm:rethinkdb:query:start')
const finishCh = channel('apm:rethinkdb:query:finish')
const errorCh = channel('apm:rethinkdb:query:error')

addHook({ name: 'rethinkdb', versions: ['>=2'], file: 'net.js' }, net => {
  shimmer.wrap(net.Connection.prototype, '_start', _start => function (term, cb, opts) {
    if (!startCh.hasSubscribers) {
      return _start.apply(this, arguments)
    }

    const ctx = {
      query: term ? term.toString() : undefined,
      host: this.host,
      port: this.port,
      db: this.db
    }

    return startCh.runStores(ctx, () => {
      if (typeof cb === 'function') {
        arguments[1] = function (err, result) {
          if (err) {
            ctx.error = err
            errorCh.publish(ctx)
          }
          ctx.result = result
          finishCh.publish(ctx)

          return cb(err, result)
        }
      }

      try {
        return _start.apply(this, arguments)
      } catch (err) {
        ctx.error = err
        errorCh.publish(ctx)
        finishCh.publish(ctx)
        throw err
      }
    })
  })

  return net
})
