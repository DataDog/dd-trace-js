'use strict'

const ExpressTracingPlugin = require('./tracing')
const ExpressCodeOriginForSpansPlugin = require('./code_origin')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class ExpressPlugin extends CompositePlugin {
  static get id () { return 'express' }
  static get plugins () {
    return {
      tracing: ExpressTracingPlugin,
      codeOriginForSpans: ExpressCodeOriginForSpansPlugin
    }
  }
}

module.exports = ExpressPlugin
