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
    const { instance, request, resource, stream } = ctx

    const span = this.startSpan('vertexai.request', {
      service: this.config.service,
      resource,
      kind: 'client',
      meta: {
        [MEASURED]: 1
      }
    }, false)

    const tags = this.tagRequest(request, instance, stream, span)
    span.addTags(tags)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    span.finish()
  }

  /**
   * Generate the request tags.
   *
   * @param {Object} request
   * @param {Object} instance
   * @param {boolean} stream
   * @param {Span} span
   * @returns {Object}
   */
  tagRequest (request, instance, stream, span) {
    const model = extractModel(instance)
    const tags = {
      'vertexai.request.model': model
    }
    return tags
  }
}

module.exports = GoogleCloudVertexAITracingPlugin
