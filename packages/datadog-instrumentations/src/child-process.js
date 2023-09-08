'use strict'

const {
  channel,
  addHook, AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const childProcessChannelStart = channel('datadog:child_process:execution:start')
const childProcessChannelFinish = channel('datadog:child_process:execution:finish')
const childProcessChannelError = channel('datadog:child_process:execution:error')

// ignored exec method because it calls to execFile directly
const execAsyncMethods = ['execFile', 'spawn', 'fork']
const execSyncMethods = ['execFileSync', 'execSync', 'spawnSync']

const names = ['child_process', 'node:child_process']

// child_process and node:child_process returns the same object, we only want to add hooks once
let patched = false
names.forEach(name => {
  addHook({ name }, childProcess => {
    if (!patched) {
      patched = true
      shimmer.massWrap(childProcess, execAsyncMethods, wrapChildProcessAsyncMethod())
      shimmer.massWrap(childProcess, execSyncMethods, wrapChildProcessSyncMethod())
    }

    return childProcess
  })
})

function wrapChildProcessSyncMethod () {
  function wrapMethod (childProcessMethod) {
    return function () {
      if (!childProcessChannelStart.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const command = arguments[0]
      childProcessChannelStart.publish({ command })

      let error
      try {
        return childProcessMethod.apply(this, arguments)
      } catch (err) {
        childProcessChannelError.publish(err?.status)
        error = err
        throw err
      } finally {
        if (childProcessChannelFinish.hasSubscribers && arguments.length > 0) {
          childProcessChannelFinish.publish({ exitCode: error?.status || 0 })
        }
      }
    }
  }

  return wrapMethod
}

function wrapChildProcessAsyncMethod () {
  function wrapMethod (childProcessMethod) {
    return function () {
      if (!childProcessChannelStart.hasSubscribers) {
        return childProcessMethod.apply(this, arguments)
      }

      const innerResource = new AsyncResource('bound-anonymous-fn')
      const command = arguments[0]
      return innerResource.runInAsyncScope(() => {
        childProcessChannelStart.publish({ command })
        const childProcess = childProcessMethod.apply(this, arguments)

        if (childProcess) {
          let errorExecuted = false
          childProcess.on('error', (e) => {
            errorExecuted = true
            childProcessChannelError.publish(e)
          })

          childProcess.on('close', (code) => {
            code = code || 0
            if (!errorExecuted && code !== 0) {
              childProcessChannelError.publish()
            }
            childProcessChannelFinish.publish({ exitCode: code })
          })
        }

        return childProcess
      })
    }
  }
  return wrapMethod
}
