'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const handlebarsReadCh = channel('datadog:handlebars:compile:start')

function wrapCompile (compile) {
  return function () {
    if (handlebarsReadCh.hasSubscribers) {
      const source = arguments[0]
      handlebarsReadCh.publish({ source })
    }
    return compile.apply(this, arguments)
  }
}

addHook({ name: 'handlebars', file: 'dist/cjs/handlebars/compiler/compiler.js', versions: ['>=4.0.0'] }, compiler => {
  shimmer.wrap(compiler, 'compile', wrapCompile)
  shimmer.wrap(compiler, 'precompile', wrapCompile)
  return compiler
})
