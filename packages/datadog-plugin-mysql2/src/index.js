'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class MySQL2Plugin extends Plugin {
  static get name () {
    return 'mysql2'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:mysql2:addCommand:start', ([sql, conf]) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('mysql.query', {
        childOf,
        tags: {
          'service.name': this.config.service || `${this.tracer._service}-mysql`,
          'span.type': 'sql',
          'span.kind': 'client',
          'db.type': 'mysql',
          'db.user': conf.user,
          'out.host': conf.host,
          'out.port': conf.port,
          'resource.name': sql
        }
      })

      if (conf.database) {
        span.setTag('db.name', conf.database)
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:mysql2:addCommand:end', () => {
      this.exit()
    })

    this.addSub('apm:mysql2:addCommand:error', err => {
      if (err) {
        const span = storage.getStore().span
        span.setTag('error', err)
      }
    })

    this.addSub('apm:mysql2:addCommand:async-end', () => {
      const span = storage.getStore().span
      span.finish()
    })
  }
}

module.exports = MySQL2Plugin