'use strict'

const Tags = require('opentracing').Tags

const OPERATION_NAME = 'pg.query'

function patch (pg, tracer, config) {
  function queryWrap (query) {
    return function queryTrace () {
      const pgQuery = query.apply(this, arguments)
      const originalCallback = pgQuery.callback
      const statement = pgQuery.text
      const params = this.connectionParameters

      const parentScope = tracer.scopeManager().active()
      const parent = parentScope && parentScope.span()
      const span = tracer.startSpan(OPERATION_NAME, {
        childOf: parent,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          'service.name': config.service || `${tracer._service}-postgres`,
          'resource.name': statement,
          'span.type': 'sql',
          'db.type': 'postgres'
        }
      })

      if (params) {
        span.addTags({
          'db.name': params.database,
          'db.user': params.user,
          'out.host': params.host,
          'out.port': params.port
        })
      }

      pgQuery.callback = (err, res) => {
        if (err) {
          span.addTags({
            'error.type': err.name,
            'error.msg': err.message,
            'error.stack': err.stack
          })
        }

        span.finish()

        if (originalCallback) {
          if (parent) {
            tracer.scopeManager().activate(parent)
          }

          originalCallback(err, res)
        }
      }

      return pgQuery
    }
  }

  this.wrap(pg.Client.prototype, 'query', queryWrap)
}

function unpatch (pg) {
  this.unwrap(pg.Client.prototype, 'query')
}

module.exports = {
  name: 'pg',
  versions: ['6.x'],
  patch,
  unpatch
}
