'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class MariadbPlugin extends Plugin {
  static get name () {
    return 'mariadb'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:mariadb:query:start', ({ sql }) => {
      const service = getServiceName(this.tracer, this.config)
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const tags = {
        'service.name': service,
        'span.type': 'sql',
        'span.kind': 'client',
        'db.type': 'mysql',
        'resource.name': sql
      }

      const span = this.tracer.startSpan('mariadb.query', {
        childOf,
        tags
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:mariadb:query:error', (err) => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub('apm:mariadb:query:finish', () => {
      const span = storage.getStore().span
      span.finish()
    })
  }
}

function getServiceName (tracer, config) {
  if (typeof config.service === 'function') {
    return config.service()
  } else if (config.service) {
    return config.service
  } else {
    return `${tracer._service}-mariadb`
  }
}

module.exports = MariadbPlugin
