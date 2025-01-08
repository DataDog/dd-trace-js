'use strict'

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const names = ['vm', 'node:vm']

const runScriptStartChannel = channel('datadog:vm:run-script:start')

addHook({ name: names }, function (vm) {
  vm.Script = class extends vm.Script {
    constructor (code) {
      super(...arguments)
      this.code = code
    }
  }

  shimmer.wrap(vm.Script.prototype, 'runInContext', wrapVMMethod(1))
  shimmer.wrap(vm.Script.prototype, 'runInNewContext', wrapVMMethod())
  shimmer.wrap(vm.Script.prototype, 'runInThisContext', wrapVMMethod())

  shimmer.wrap(vm, 'runInContext', wrapVMMethod())
  shimmer.wrap(vm, 'runInNewContext', wrapVMMethod())
  shimmer.wrap(vm, 'runInThisContext', wrapVMMethod())
  shimmer.wrap(vm, 'compileFunction', wrapVMMethod())

  return vm
})

function wrapVMMethod (codeIndex = 0) {
  return function wrap (original) {
    return function wrapped () {
      const code = arguments[codeIndex] ? arguments[codeIndex] : this.code

      if (runScriptStartChannel.hasSubscribers && code) {
        runScriptStartChannel.publish({ code })
      }

      return original.apply(this, arguments)
    }
  }
}
