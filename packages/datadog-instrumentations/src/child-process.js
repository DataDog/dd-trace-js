'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const childProcessChannelStart = channel('datadog:child_process:execution:start')
const childProcessChannelFinish = channel('datadog:child_process:execution:finish')
const childProcessChannelError = channel('datadog:child_process:execution:error')
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
      if (childProcessChannelStart.hasSubscribers && arguments.length > 0) {
        const command = arguments[0]
        childProcessChannelStart.publish({ command })
      }

      let ret

      // TODO: exec, execFile, fork, spawn promise or callback
      try {
        ret = childProcessMethod.apply(this, arguments)
      } catch (err) {
        childProcessChannelError.publish(err?.status)
        throw err
      } finally {
        if (childProcessChannelFinish.hasSubscribers && arguments.length > 0) {
          childProcessChannelFinish.publish({ exitCode: ret })
        }
      }
      return ret
    }
  }
  return wrapMethod
}
