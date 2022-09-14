'use strict'

const {
  addHook,
  TracingChannel
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = new TracingChannel('apm:pg:query')

addHook({ name: 'pg', versions: ['>=8.0.3'] }, pg => {
  shimmer.wrap(pg.Client.prototype, 'query', query => wrapQuery(query))
  return pg
})

addHook({ name: 'pg', file: 'lib/native/index.js', versions: ['>=8.0.3'] }, Client => {
  shimmer.wrap(Client.prototype, 'query', query => wrapQuery(query))
  return Client
})

function wrapQuery (query) {
  return function () {
    if (!tracingChannel.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const retval = query.apply(this, arguments)

    const queryQueue = this.queryQueue || this._queryQueue
    const activeQuery = this.activeQuery || this._activeQuery
    const pgQuery = queryQueue[queryQueue.length - 1] || activeQuery

    if (!pgQuery) {
      return retval
    }

    const statement = pgQuery.text

    return tracingChannel.trace((done) => {
      if (pgQuery.callback) {
        const originalCallback = pgQuery.callback
        pgQuery.callback = function (err, res) {
          done(err)
          return originalCallback.apply(this, arguments)
        }
      } else if (pgQuery.once) {
        pgQuery
          .once('error', done)
          .once('end', () => done())
      } else {
        pgQuery.then(() => done(), done)
      }

      return retval
    }, { params: this.connectionParameters, statement })
  }
}
