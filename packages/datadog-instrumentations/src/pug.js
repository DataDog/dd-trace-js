'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const pugCompileCh = channel('datadog:pug:compile:start')

function wrapCompile (compile) {
  return function wrappedCompile (source) {
    if (pugCompileCh.hasSubscribers) {
      pugCompileCh.publish({ source })
    }

    return compile.apply(this, arguments)
  }
}

addHook({ name: 'pug', versions: ['>=2.0.4'] }, compiler => {
  shimmer.wrap(compiler, 'compile', wrapCompile)
  shimmer.wrap(compiler, 'compileClientWithDependenciesTracked', wrapCompile)

  return compiler
})
