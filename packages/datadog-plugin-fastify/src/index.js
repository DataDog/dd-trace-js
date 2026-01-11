'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const FastifyTracingPlugin = require('./tracing')
const FastifyCodeOriginForSpansPlugin = require('./code_origin')

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
