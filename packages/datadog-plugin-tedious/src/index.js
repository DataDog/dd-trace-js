'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class TediousPlugin extends Plugin {
  static get name () {
    return 'tedious'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:tedious:request:start`, ({ queryOrProcedure, connectionConfig }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('tedious.request', {
        childOf,
        tags: {
          'span.kind': 'client',
          'db.type': 'mssql',
          'span.type': 'sql',
          'component': 'tedious',
          'service.name': this.config.service || `${this.tracer._service}-mssql`,
          'resource.name': queryOrProcedure,
          'out.host': connectionConfig.server,
          'out.port': connectionConfig.options.port,
          'db.user': connectionConfig.userName || connectionConfig.authentication.options.userName,
          'db.name': connectionConfig.options.database,
          'db.instance': connectionConfig.options.instanceName
        }
      })
      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:tedious:request:end`, () => {
      this.exit()
    })

    this.addSub(`apm:tedious:request:error`, err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub(`apm:tedious:request:async-end`, () => {
      const span = storage.getStore().span
      span.finish()
    })
  }
}

module.exports = TediousPlugin
