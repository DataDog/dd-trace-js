'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GraphQLValidatePlugin extends TracingPlugin {
  static get name () { return 'graphql' }
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
    span.finish()
  }
}

module.exports = GraphQLValidatePlugin
