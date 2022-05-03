'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class OracledbPlugin extends Plugin {
  static get name () {
    return 'oracledb'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:oracledb:execute:start', ({ query, connAttrs }) => {
      const service = getServiceName(this.tracer, this.config, connAttrs)
      const connectStringObj = new URL('http://' + connAttrs.connectString)
      const tags = {
        'span.kind': 'client',
        'span.type': 'sql',
        'sql.query': query,
        'db.instance': connectStringObj.pathname.substring(1),
        'db.hostname': connectStringObj.hostname,
        'db.user': this.config.user,
        'db.port': connectStringObj.port,
        'resource.name': query,
        'service.name': service
      }
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('oracle.query', {
        childOf,
        tags
      })
      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:oracledb:execute:error', err => {
      const store = storage.getStore()
      if (store && store.span) {
        store.span.setTag('error', err)
      }
    })

    this.addSub('apm:oracledb:execute:finish', () => {
      const store = storage.getStore()
      if (store && store.span) {
        store.span.finish()
      }
    })
  }
}

function getServiceName (tracer, config, connAttrs) {
  if (typeof config.service === 'function') {
    return config.service(connAttrs)
  } else if (config.service) {
    return config.service
  } else {
    return `${tracer._service}-oracle`
  }
}

module.exports = OracledbPlugin
