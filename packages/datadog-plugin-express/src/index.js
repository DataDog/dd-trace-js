'use strict'

const ExpressTracingPlugin = require('./tracing')
const ExpressCodeOriginForSpansPlugin = require('./code-origin')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class ExpressPlugin extends CompositePlugin {
  static id = 'express'
  static get plugins () {
    return {
      tracing: ExpressTracingPlugin,
      codeOriginForSpans: ExpressCodeOriginForSpansPlugin
    }
  }
}

module.exports = ExpressPlugin
