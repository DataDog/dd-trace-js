'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class MYSQLPlugin extends Plugin {
  static get name () {
    return 'mysql'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:mysql:query:start', () => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('mysql.query', {
        childOf,
        tags: {
          // [this.Tags.SPAN_KIND]: this.Tags.SPAN_KIND_RPC_CLIENT,
          'service.name': this.config.service || `${this.tracer._service}-mysql`,
          'span.type': 'sql',
          'span.kind': 'client',
          'db.type': 'mysql',
          'db.user': this.config.user,
          'out.host': this.config.host,
          'out.port': this.config.port
        }
      })

      if (this.config.database) {
        span.setTag('db.name', this.config.database)
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:mysql:query:end', () => {
      this.exit()
    })

    this.addSub('apm:mysql:query:error', err => {
      const span = storage.getStore().span

      if (err) {
        span.addTags({
          'error.type': err.name,
          'error.msg': err.message,
          'error.stack': err.stack
        })
      }
      span.finish()
    })

    this.addSub('apm:mysql:query:async-end', () => {
      const span = storage.getStore().span
      span.finish()
    })
  }
}

module.exports = MYSQLPlugin
