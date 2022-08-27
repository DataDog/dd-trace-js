'use strict'

const { Plugin, TracingSubscription } = require('../../dd-trace/src/plugins/plugin')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class PGQuerySubscription extends TracingSubscription {
  prefix = 'apm:pg:query'

  start ({ params, statement }, store) {
    const service = getServiceName(this.plugin.tracer, this.plugin.config, params)
    const childOf = store ? store.span : store
    const span = this.plugin.tracer.startSpan('pg.query', {
      childOf,
      tags: {
        'service.name': service,
        'span.type': 'sql',
        'span.kind': 'client',
        'db.type': 'postgres',
        'resource.name': statement
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

    analyticsSampler.sample(span, this.plugin.config.measured)
    return span
  }

  asyncEnd (ctx) {
    ctx.span.finish()
    this.plugin.exit(ctx)
  }
}

class PGPlugin extends Plugin {
  tracingSubscriptions = [PGQuerySubscription]

  static get name () {
    return 'pg'
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

module.exports = PGPlugin
