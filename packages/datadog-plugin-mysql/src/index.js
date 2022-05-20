'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class MySQLPlugin extends Plugin {
  static get name () {
    return 'mysql'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.name}:query:start`, ({ sql, conf: dbConfig }) => {
      const service = getServiceName(this.tracer, this.config, dbConfig)
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('mysql.query', {
        childOf,
        tags: {
          'service.name': service,
          'span.type': 'sql',
          'span.kind': 'client',
          'db.type': 'mysql',
          'db.user': dbConfig.user,
          'out.host': dbConfig.host,
          'out.port': dbConfig.port,
          'resource.name': sql
        }
      })

      if (dbConfig.database) {
        span.setTag('db.name', dbConfig.database)
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:${this.constructor.name}:query:end`, () => {
      this.exit()
    })

    this.addSub(`apm:${this.constructor.name}:query:error`, err => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })

    this.addSub(`apm:${this.constructor.name}:query:async-end`, () => {
      const span = storage.getStore().span
      span.finish()
    })
  }
}

function getServiceName (tracer, config, dbConfig) {
  if (typeof config.service === 'function') {
    return config.service(dbConfig)
  } else if (config.service) {
    return config.service
  } else {
    return `${tracer._service}-mysql`
  }
}

module.exports = MySQLPlugin
