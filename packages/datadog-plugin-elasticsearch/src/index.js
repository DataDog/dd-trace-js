'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

const ELASTICSEARCH_URL = 'elasticsearch.url'
const ELASTICSEARCH_METHOD = 'elasticsearch.method'
const ELASTICSEARCH_BODY = 'elasticsearch.body'
const ELASTICSEARCH_PARAMS = 'elasticsearch.params'

class ElasticsearchPlugin extends DatabasePlugin {
  static id = 'elasticsearch'

  bindStart (ctx) {
    const { params } = ctx

    const meta = {
      'db.type': this.system,
      [ELASTICSEARCH_URL]: params.path,
      [ELASTICSEARCH_METHOD]: params.method,
      [ELASTICSEARCH_BODY]: getBody(params.body || params.bulkBody),
    }

    const queryString = params.querystring || params.query
    if (queryString !== undefined) {
      meta[ELASTICSEARCH_PARAMS] = JSON.stringify(queryString)
    }

    this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config }),
      resource: `${params.method} ${quantizePath(params.path)}`,
      type: 'elasticsearch',
      kind: 'client',
      meta,
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
