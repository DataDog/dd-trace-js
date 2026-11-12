'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TypeSafeLLMObsPlugin = require('../../dd-trace/src/llmobs/plugins/typesafe')
const TypeSafeTracingPlugin = require('./tracing')

class TypeSafePlugin extends CompositePlugin {
  static id = 'typesafe'
  static get plugins () {
    return {
      llmobs: TypeSafeLLMObsPlugin,
      tracing: TypeSafeTracingPlugin,
    }
  }
}

module.exports = TypeSafePlugin
