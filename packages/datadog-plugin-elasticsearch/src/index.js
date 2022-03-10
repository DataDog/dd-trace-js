'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class ElasticsearchPlugin extends Plugin {
  static get name () {
    return 'elasticsearch'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:elasticsearch:query:start', ({ params }) => {
      this.startSpan('elasticsearch.query', {
        service: this.config.service || `${this.tracer.config.service}-elasticsearch`,
        resource: `${params.method} ${quantizePath(params.path)}`,
        type: 'elasticsearch',
        kind: 'client',
        meta: {
          'db.type': 'elasticsearch',
          'elasticsearch.url': params.path,
          'elasticsearch.method': params.method,
          'elasticsearch.body': getBody(params.body || params.bulkBody),
          'elasticsearch.params': JSON.stringify(params.querystring || params.query)
        }
      })
    })

    this.addSub('apm:elasticsearch:query:end', () => {
      this.exit()
    })

    this.addSub('apm:elasticsearch:query:error', err => {
      this.addError(err)
    })

    this.addSub('apm:elasticsearch:query:async-end', ({ params }) => {
      const span = this.activeSpan
      this.config.hooks.query(span, params)
      span.finish()
    })
  }

  configure (config) {
    super.configure(normalizeConfig(config))
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

module.exports = ElasticsearchPlugin
