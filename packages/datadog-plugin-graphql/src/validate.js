'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { extractErrorIntoSpanEvent } = require('./utils')

class GraphQLValidatePlugin extends TracingPlugin {
  static get id () { return 'graphql' }
  static get operation () { return 'validate' }

  start ({ docSource, document }) {
    const source = this.config.source && document && docSource

    this.startSpan('graphql.validate', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        'graphql.source': source
      }
    })
  }

  finish ({ document, errors }) {
    const span = this.activeSpan
    this.config.hooks.validate(span, document, errors)
    if (errors) {
      for (const err of errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }
    super.finish()
  }
}

module.exports = GraphQLValidatePlugin
