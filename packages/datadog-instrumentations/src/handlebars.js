'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const handlebarsCompileCh = channel('datadog:handlebars:compile:start')
const handlebarsRegisterPartialCh = channel('datadog:handlebars:register-partial:start')

function wrapCompile (compile) {
  return function wrappedCompile (source) {
    if (handlebarsCompileCh.hasSubscribers) {
      handlebarsCompileCh.publish({ source })
    }

    return compile.apply(this, arguments)
  }
}

function wrapRegisterPartial (registerPartial) {
  return function wrappedRegisterPartial (name, partial) {
    if (handlebarsRegisterPartialCh.hasSubscribers) {
      handlebarsRegisterPartialCh.publish({ partial })
    }

    return registerPartial.apply(this, arguments)
  }
}

addHook({ name: 'handlebars', file: 'dist/cjs/handlebars/compiler/compiler.js', versions: ['>=4.0.0'] }, compiler => {
  shimmer.wrap(compiler, 'compile', wrapCompile)
  shimmer.wrap(compiler, 'precompile', wrapCompile)

  return compiler
})

addHook({ name: 'handlebars', file: 'dist/cjs/handlebars/base.js', versions: ['>=4.0.0'] }, base => {
  shimmer.wrap(base.HandlebarsEnvironment.prototype, 'registerPartial', wrapRegisterPartial)

  return base
})
