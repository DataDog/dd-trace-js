'use strict'

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const names = ['vm', 'node:vm']

const runScriptStartChannel = channel('datadog:vm:run-script:start')

addHook({ name: names }, function (vm) {
  vm.Script = class extends vm.Script {
    constructor (code) {
      super(...arguments)

      if (runScriptStartChannel.hasSubscribers && code) {
        runScriptStartChannel.publish({ code })
      }
    }
  }

  shimmer.wrap(vm, 'runInContext', wrapVMMethod)
  shimmer.wrap(vm, 'runInNewContext', wrapVMMethod)
  shimmer.wrap(vm, 'runInThisContext', wrapVMMethod)
  shimmer.wrap(vm, 'compileFunction', wrapVMMethod)

  return vm
})

function wrapVMMethod (original) {
  return function wrappedVMMethod (code) {
    if (runScriptStartChannel.hasSubscribers && code) {
      runScriptStartChannel.publish({ code })
    }

    return original.apply(this, arguments)
  }
}
