'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PGPlugin extends DatabasePlugin {
  static id = 'pg'
  static operation = 'query'
  static system = 'postgres'

  constructor () {
    super(...arguments)

    this.addSub('apm:pg:pool:connect:start', ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })
    this.addBind('apm:pg:pool:connect:finish', ctx => ctx.parentStore)

    this.addSub('apm:pg:pool:acquire:start', ctx => {
      const params = ctx.poolOptions ?? {}

      ctx.acquireSpan = this.startSpan('pg.pool.acquire', {
        service: this.serviceName({ pluginConfig: this.config, params }),
        resource: 'pg.pool.acquire',
        type: 'sql',
        kind: 'client',
        meta: {
          'db.type': 'postgres',
          'db.name': params.database,
          'db.user': params.user,
          'out.host': params.host,
          [CLIENT_PORT_KEY]: params.port,
        },
      }, false)
    })
    this.addSub('apm:pg:pool:acquire:finish', ctx => {
      const span = ctx.acquireSpan

      if (ctx.error) {
        this.addError(ctx.error, span)
      }
      span.setTag('pg.pool.wait_time', ctx.poolWaitTime)
      span.finish()
    })
  }

  bindStart (ctx) {
    const { params = {}, query, originalText, processId, stream } = ctx
    const service = this.serviceName({ pluginConfig: this.config, params })
    const originalStatement = this.maybeTruncate(originalText)

    const span = this.startSpan(this.operationName(), {
      service,
      resource: originalStatement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.pid': processId,
        'db.name': params.database,
        'db.user': params.user,
        'out.host': params.host,
        [CLIENT_PORT_KEY]: params.port,
      },
    }, ctx)

    if (stream) {
      span.setTag('db.stream', 1)
    }

    if (ctx.poolWaitTime !== undefined) {
      span.setTag('pg.pool.wait_time', ctx.poolWaitTime)
    }

    ctx.injected = this.injectDbmQuery(span, originalText, service.name, !!query.name)

    return ctx.currentStore
  }
}

module.exports = PGPlugin
