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

      pgQuery.callback = (err, res) => {
        tracer.trace(OPERATION_NAME, {
          tags: {
            [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
            [Tags.DB_TYPE]: 'postgres'
          }
        }, span => {
          span.setTag('service.name', config.service || 'postgres')
          span.setTag('resource.name', statement)
          span.setTag('span.type', 'sql')

          if (params) {
            span.setTag('db.name', params.database)
            span.setTag('db.user', params.user)
            span.setTag('out.host', params.host)
            span.setTag('out.port', String(params.port))
          }

          if (err) {
            span.addTags({
              'error.type': err.name,
              'error.msg': err.message,
              'error.stack': err.stack
            })
          }

          span.finish()
        })

        if (originalCallback) {
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
