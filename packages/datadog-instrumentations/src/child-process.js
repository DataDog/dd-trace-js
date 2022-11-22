'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const childProcessChannel = channel('datadog:child_process:execution:start')
const execMethods = ['exec', 'execFile', 'fork', 'spawn', 'execFileSync', 'execSync', 'spawnSync']
const names = ['child_process', 'node:child_process']
names.forEach(name => {
  addHook({ name }, childProcess => {
    shimmer.massWrap(childProcess, execMethods, wrapChildProcessMethod())
    return childProcess
  })
})

function wrapChildProcessMethod () {
  function wrapMethod (childProcessMethod) {
    return function () {
      if (childProcessChannel.hasSubscribers && arguments.length > 0) {
        const command = arguments[0]
        childProcessChannel.publish({ command })
      }
      return childProcessMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}
