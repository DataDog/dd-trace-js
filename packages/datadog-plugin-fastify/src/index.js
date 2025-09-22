'use strict'

const FastifyTracingPlugin = require('./tracing')
const FastifyCodeOriginForSpansPlugin = require('./code-origin')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class FastifyPlugin extends CompositePlugin {
  static id = 'fastify'
  static get plugins () {
    return {
      tracing: FastifyTracingPlugin,
      codeOriginForSpans: FastifyCodeOriginForSpansPlugin
    }
  }
}

module.exports = FastifyPlugin
