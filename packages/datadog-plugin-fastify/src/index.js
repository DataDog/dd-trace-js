'use strict'

const FastifyTracingPlugin = require('./tracing')
const FastifyCodeOriginForSpansPlugin = require('./code_origin')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class FastifyPlugin extends CompositePlugin {
  static get id () { return 'fastify' }
  static get plugins () {
    return {
      tracing: FastifyTracingPlugin,
      codeOriginForSpans: FastifyCodeOriginForSpansPlugin
    }
  }
}

module.exports = FastifyPlugin
