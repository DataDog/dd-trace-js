'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class ElasticSearchPlugin extends Plugin {
  static get name () {
    return 'elasticsearch'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:elasticsearch:query:start', ([params]) => {
      debugger;
      this.config = normalizeConfig(this.config)

      const store = storage.getStore()
      const childOf = store ? store.span : store
      const body = getBody(params.body || params.bulkBody)
      const span = this.tracer.startSpan('elasticsearch.query', {
        childOf,
        tags: {
          'db.type': 'elasticsearch',
          'span.kind': 'client',
          'service.name': this.config.service || `${this.tracer._service}-elasticsearch`,
          'resource.name': `${params.method} ${quantizePath(params.path)}`,
          'span.type': 'elasticsearch',
          'elasticsearch.url': params.path,
          'elasticsearch.method': params.method,
          'elasticsearch.body': body,
          'elasticsearch.params': JSON.stringify(params.querystring || params.query)
        }
      })
      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:elasticsearch:query:end', () => {
      debugger;
      this.exit()
    })

    this.addSub('apm:elasticsearch:query:error', err => {
      debugger;
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub('apm:elasticsearch:query:async-end', ([params]) => {
      debugger;
      const span = storage.getStore().span
      this.config.hooks.query(span, params)
      span.finish()
    })
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)

  return Object.assign({}, config, {
    hooks
  })
}

function getHooks (config) {
  const noop = () => {}
  const query = (config.hooks && config.hooks.query) || noop

  return { query }
}

function getBody (body) {
  return body && JSON.stringify(body)
}

function quantizePath (path) {
  return path && path.replace(/[0-9]+/g, '?')
}

module.exports = ElasticSearchPlugin