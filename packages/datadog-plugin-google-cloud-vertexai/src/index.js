'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const makeUtilities = require('../../dd-trace/src/plugins/util/llm')

class GoogleCloudVertexAIPlugin extends TracingPlugin {
  static get id () { return 'google-cloud-vertexai' }
  static get prefix () {
    return 'tracing:apm:vertexai:request'
  }

  constructor () {
    super(...arguments)

    this.utilities = makeUtilities('vertexai', this._tracerConfig)
  }

  bindStart (ctx) {
    const { func } = ctx

    // TODO: tag request

    const span = this.startSpan('vertexai.request', {
      service: this.config.service,
      resource: `GenerativeModel.${func}`,
      kind: 'client',
      meta: {
        [MEASURED]: 1
      }
    }, false)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span

    // TODO: tag response

    span.finish()
  }

  tagRequest (span, request) {}

  tagResponse (span, response) {}
}

module.exports = GoogleCloudVertexAIPlugin
