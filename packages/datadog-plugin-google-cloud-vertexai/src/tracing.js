'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const makeUtilities = require('../../dd-trace/src/plugins/util/llm')

const {
  extractModel,
} = require('./utils')

class GoogleCloudVertexAITracingPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-vertexai' }
  static get prefix () {
    return 'tracing:apm:vertexai:request'
  }

  constructor () {
    super(...arguments)

    Object.assign(this, makeUtilities('vertexai', this._tracerConfig))
  }

  bindStart (ctx) {
    const { instance, resource } = ctx

    const span = this.startSpan('vertexai.request', {
      service: this.config.service,
      resource,
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        'vertexai.request.model': extractModel(instance)
      }
    }, false)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    span.finish()
  }
}

module.exports = GoogleCloudVertexAITracingPlugin
