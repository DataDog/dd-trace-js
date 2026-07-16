'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class ElasticsearchPlugin extends DatabasePlugin {
  static id = 'elasticsearch'

  #urlTag
  #methodTag
  #bodyTag
  #paramsTag

  constructor (...args) {
    super(...args)

    // Per-instance because `system` differs on the OpenSearchPlugin subclass.
    const { system } = this
    this.#urlTag = `${system}.url`
    this.#methodTag = `${system}.method`
    this.#bodyTag = `${system}.body`
    this.#paramsTag = `${system}.params`
  }

  bindStart (ctx) {
    const { params } = ctx

    const meta = {
      'db.type': this.system,
      [this.#urlTag]: params.path,
      [this.#methodTag]: params.method,
      [this.#bodyTag]: getBody(params.body || params.bulkBody),
    }

    const queryString = params.querystring || params.query
    if (queryString) {
      meta[this.#paramsTag] = JSON.stringify(queryString)
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
