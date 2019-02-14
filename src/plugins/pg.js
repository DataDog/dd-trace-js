'use strict'

const Tags = require('opentracing').Tags

const OPERATION_NAME = 'pg.query'

function patch (pg, tracer, config) {
  function queryWrap (query) {
    return function queryTrace () {
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan(OPERATION_NAME, {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          'service.name': config.service || `${tracer._service}-postgres`,
          'span.type': 'sql',
          'db.type': 'postgres'
        }
      })

      const retval = scope.bind(query, span).apply(this, arguments)
      const pgQuery = this.queryQueue[this.queryQueue.length - 1] || this.activeQuery

      if (!pgQuery) {
        return retval
      }

      const originalCallback = pgQuery.callback
      const statement = pgQuery.text
      const params = this.connectionParameters

      span.setTag('resource.name', statement)

      if (params) {
        span.addTags({
          'db.name': params.database,
          'db.user': params.user,
          'out.host': params.host,
          'out.port': params.port
        })
      }

      pgQuery.callback = scope.bind((err, res) => {
        if (err) {
          span.addTags({
            'error.type': err.name,
            'error.msg': err.message,
            'error.stack': err.stack
          })
        }

        span.finish()

        if (originalCallback) {
          originalCallback(err, res)
        }
      }, childOf)

      return retval
    }
  }

  this.wrap(pg.Client.prototype, 'query', queryWrap)
}

function unpatch (pg) {
  this.unwrap(pg.Client.prototype, 'query')
}

module.exports = {
  name: 'pg',
  versions: ['>=4'],
  patch,
  unpatch
}
