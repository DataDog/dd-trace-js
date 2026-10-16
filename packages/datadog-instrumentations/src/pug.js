'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const pugCompileCh = channel('datadog:pug:compile:start')
const patched = new WeakSet()

function wrapCompile (compile) {
  return function wrappedCompile (source) {
    if (pugCompileCh.hasSubscribers) {
      pugCompileCh.publish({ source })
    }

    return compile.apply(this, arguments)
  }
}

addHook({ name: 'pug', versions: ['>=2.0.4'] }, compiler => {
  for (const name of ['compile', 'compileClientWithDependenciesTracked']) {
    if (patched.has(compiler[name])) continue
    shimmer.wrap(compiler, name, wrapCompile)
    patched.add(compiler[name])
  }

  return compiler
})
