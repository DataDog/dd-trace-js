'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class PGPlugin extends Plugin {
  static get name () {
    return 'pg'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:pg:query:start', ({ params, statement }) => {
      const service = getServiceName(this.tracer, this.config, params)
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('pg.query', {
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

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:pg:connect:start', ({ params }) => {
      const service = getServiceName(this.tracer, this.config, params)
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('pg.connect', {
        childOf,
        tags: {
          'service.name': service,
          'span.type': 'sql',
          'span.kind': 'client',
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

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:pg-pool:connect:start', ({ max, idleTimeoutMillis, idleCount, totalCount, waitingCount }) => {
      const service = getServiceName(this.tracer, this.config)
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('pg-pool.connect', {
        childOf,
        tags: {
          'service.name': service,
          'span.type': 'sql',
          'span.kind': 'client',
          'db.type': 'postgres',
          'db.pool.clients.max': max,
          'db.pool.clients.idle_timeout_millis': idleTimeoutMillis,
          'db.pool.clients.idle': idleCount,
          'db.pool.clients.total': totalCount,
          'db.pool.queries.pending': waitingCount
        }
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    const end = () => { this.exit() }
    this.addSub('apm:pg:query:end', end)
    this.addSub('apm:pg:connect:end', end)
    this.addSub('apm:pg-pool:connect:end', end)

    const error = err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    }
    this.addSub('apm:pg:query:error', error)
    this.addSub('apm:pg:connect:error', error)
    this.addSub('apm:pg-pool:connect:error', error)

    const asyncEnd = () => {
      const span = storage.getStore().span
      span.finish()
    }
    this.addSub('apm:pg:query:async-end', asyncEnd)
    this.addSub('apm:pg:connect:async-end', asyncEnd)
    this.addSub('apm:pg-pool:connect:async-end', asyncEnd)
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
