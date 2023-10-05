'use strict'

const util = require('util')

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const childProcessChannelStart = channel('datadog:child_process:execution:start')
const childProcessChannelFinish = channel('datadog:child_process:execution:finish')
const childProcessChannelError = channel('datadog:child_process:execution:error')

// ignored exec method because it calls to execFile directly
const execAsyncMethods = ['execFile', 'spawn']
const execSyncMethods = ['execFileSync', 'execSync', 'spawnSync']

const names = ['child_process', 'node:child_process']

// child_process and node:child_process returns the same object instance, we only want to add hooks once
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
  return function wrapMethod (childProcessMethod) {
    return function () {
      if (!childProcessChannelStart.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      let command = arguments[0]
      const args = arguments[1]
      if (Array.isArray(args)) {
        command = command + ' ' + args.join(' ')
      }
      childProcessChannelStart.publish({ command })

      let error
      let result
      try {
        result = childProcessMethod.apply(this, arguments)
        return result
      } catch (err) {
        childProcessChannelError.publish(err)
        error = err
        throw err
      } finally {
        const exitCode = error?.status || error?.code || result?.status || 0
        if (!error && (exitCode !== 0 || result?.error)) {
          childProcessChannelError.publish()
        }
        childProcessChannelFinish.publish({ exitCode })
      }
    }
  }
}

function wrapChildProcessCustomPromisifyMethod (customPromisifyMethod) {
  return function () {
    if (!childProcessChannelStart.hasSubscribers || arguments.length === 0) {
      return customPromisifyMethod.apply(this, arguments)
    }

    const command = arguments[0]
    childProcessChannelStart.publish({ command })

    const promise = customPromisifyMethod.apply(this, arguments)
    return promise.then((res) => {
      childProcessChannelFinish.publish({ exitCode: 0 })

      return res
    }).catch((err) => {
      childProcessChannelError.publish(err.status || err.code)
      childProcessChannelFinish.publish({ exitCode: err.status || err.code || 0 })

      return Promise.reject(err)
    })
  }
}

function wrapChildProcessAsyncMethod () {
  return function wrapMethod (childProcessMethod) {
    function wrappedChildProcessMethod () {
      if (!childProcessChannelStart.hasSubscribers) {
        return childProcessMethod.apply(this, arguments)
      }

      let command = arguments[0]
      const args = arguments[1]
      if (Array.isArray(args)) {
        command = command + ' ' + args.join(' ')
      }

      const innerResource = new AsyncResource('bound-anonymous-fn')
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

    if (childProcessMethod[util.promisify.custom]) {
      const wrapedChildProcessCustomPromisifyMethod =
        shimmer.wrap(childProcessMethod[util.promisify.custom],
          wrapChildProcessCustomPromisifyMethod(childProcessMethod[util.promisify.custom]))

      // should do it in this way because the original property is readonly
      const descriptor = Object.getOwnPropertyDescriptor(childProcessMethod, util.promisify.custom)
      Object.defineProperty(wrappedChildProcessMethod,
        util.promisify.custom,
        {
          ...descriptor,
          value: wrapedChildProcessCustomPromisifyMethod
        })
    }
    return wrappedChildProcessMethod
  }
}
