'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class ElasticsearchPlugin extends DatabasePlugin {
  static get id () { return 'elasticsearch' }

  bindStart (ctx) {
    const { params } = ctx

    const body = getBody(params.body || params.bulkBody)

    this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config }),
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
    }, ctx)

    return ctx.currentStore
  }

  bindFinish (ctx) {
    const { params } = ctx

    const span = this.activeSpan
    this.config.hooks.query(span, params)
    super.finish(ctx)

    return ctx.parentStore
  }
}

function getBody (body) {
  return body && JSON.stringify(body)
}

function quantizePath (path) {
  return path && path.replaceAll(/[0-9]+/g, '?')
}

module.exports = ElasticsearchPlugin
