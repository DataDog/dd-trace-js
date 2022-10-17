'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class ElasticsearchPlugin extends DatabasePlugin {
  static get name () { return 'elasticsearch' }

  start ({ params }) {
    const body = getBody(params.body || params.bulkBody)

    this.startSpan(`${this.system}.query`, {
      service: this.config.service,
      resource: `${params.method} ${quantizePath(params.path)}`,
      type: 'elasticsearch',
      kind: 'client',
      meta: {
        'db.type': this.system,
        [`${this.system}.url`]: params.path,
        [`${this.system}.method`]: params.method,
        [`${this.system}.body`]: body,
        [`${this.system}.params`]: JSON.stringify(params.querystring || params.query)
      }
    })
  }

  finish ({ params }) {
    const span = this.activeSpan()
    this.config.hooks.query(span, params)
    super.finish({ params })
  }
}

function getBody (body) {
  return body && JSON.stringify(body)
}

function quantizePath (path) {
  return path && path.replace(/[0-9]+/g, '?')
}

module.exports = ElasticsearchPlugin
