'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const OPERATION_NAME = 'pg.query'

function createWrapQuery (tracer, config) {
  return function wrapQuery (query) {
    return function queryWithTrace () {
      const scope = tracer.scope()
      const childOf = scope.active()
      const params = this.connectionParameters
      const service = getServiceName(tracer, config, params)
      const span = tracer.startSpan(OPERATION_NAME, {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          'service.name': service,
          'span.type': 'sql',
          'span.kind': 'client',
          'db.type': 'postgres'
        }
      })

      analyticsSampler.sample(span, config.measured)

      const retval = scope.bind(query, span).apply(this, arguments)
      const queryQueue = this.queryQueue || this._queryQueue
      const activeQuery = this.activeQuery || this._activeQuery
      const pgQuery = queryQueue[queryQueue.length - 1] || activeQuery

      if (!pgQuery) {
        return retval
      }

      const originalCallback = pgQuery.callback
      const statement = pgQuery.text

      span.setTag('resource.name', statement)

      if (params) {
        span.addTags({
          'db.name': params.database,
          'db.user': params.user,
          'out.host': params.host,
          'out.port': params.port
        })
      }

      const finish = (error) => {
        span.setTag('error', error)
        span.finish()
      }

      if (originalCallback) {
        pgQuery.callback = scope.bind((err, res) => {
          finish(err)
          originalCallback(err, res)
        }, childOf)
      } else if (pgQuery.once) {
        pgQuery
          .once('error', finish)
          .once('end', () => finish())
      } else {
        pgQuery.then(() => finish(), finish)
      }

      return retval
    }
  }
}

function getServiceName (tracer, config, params) {
  if (typeof config.service === 'function') {
    return config.service(params)
  } else if (config.service) {
    return config.service
  } else {
    return `${tracer._service}-postgres`
  }
}

module.exports = [
  {
    name: 'pg',
    versions: ['>=4'],
    patch (pg, tracer, config) {
      this.wrap(pg.Client.prototype, 'query', createWrapQuery(tracer, config))
    },
    unpatch (pg) {
      this.unwrap(pg.Client.prototype, 'query')
    }
  },
  {
    name: 'pg',
    versions: ['>=4'],
    file: 'lib/native/index.js',
    patch (Client, tracer, config) {
      this.wrap(Client.prototype, 'query', createWrapQuery(tracer, config))
    },
    unpatch (Client) {
      this.unwrap(Client.prototype, 'query')
    }
  }
]
