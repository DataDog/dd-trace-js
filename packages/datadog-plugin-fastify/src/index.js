'use strict'

const FastifyInstrumentationPlugin = require('./instrumentation')
const FastifyCodeOriginForSpansPlugin = require('../../datadog-plugin-code-origin/src/fastify')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class FastifyPlugin extends CompositePlugin {
  static get id () { return 'fastify' }
  static get plugins () {
    return {
      instrumentation: FastifyInstrumentationPlugin,
      codeOrigin: FastifyCodeOriginForSpansPlugin
    }
  }
}

module.exports = FastifyPlugin
