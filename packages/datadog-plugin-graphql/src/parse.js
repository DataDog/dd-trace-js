'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GraphQLParsePlugin extends TracingPlugin {
  static get id () { return 'graphql' }
  static get operation () { return 'parser' }

  start () {
    this.startSpan('graphql.parse', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        'graphql.source': ''
      }
    })
  }

  finish ({ source, document, docSource }) {
    const span = this.activeSpan

    if (this.config.source && document) {
      span.setTag('graphql.source', docSource)
    }

    this.config.hooks.parse(span, source, document)

    super.finish()
  }
}

module.exports = GraphQLParsePlugin
