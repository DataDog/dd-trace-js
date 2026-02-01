'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ExpressTracingPlugin = require('./tracing')
const ExpressCodeOriginForSpansPlugin = require('./code_origin')

class ExpressPlugin extends CompositePlugin {
  static id = 'express'
  static get plugins () {
    return {
      tracing: ExpressTracingPlugin,
      codeOriginForSpans: ExpressCodeOriginForSpansPlugin,
    }
  }
}

module.exports = ExpressPlugin
