'use strict'

const util = require('util')

const {
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

// ignored exec method because it calls to execFile directly
const execAsyncMethods = ['execFile', 'spawn']
const execSyncMethods = ['execFileSync', 'spawnSync']

const names = ['child_process', 'node:child_process']

// child_process and node:child_process returns the same object instance, we only want to add hooks once
let patched = false
names.forEach(name => {
  addHook({ name }, childProcess => {
    if (!patched) {
      patched = true
      shimmer.massWrap(childProcess, execAsyncMethods, wrapChildProcessAsyncMethod())
      shimmer.massWrap(childProcess, execSyncMethods, wrapChildProcessSyncMethod())
      shimmer.wrap(childProcess, 'execSync', wrapChildProcessSyncMethod(true))
    }

    return childProcess
  })
})

function normalizeArgs (args, shell) {
  const childProcessInfo = {
    command: args[0]
  }

  if (Array.isArray(args[1])) {
    childProcessInfo.command = childProcessInfo.command + ' ' + args[1].join(' ')
    if (args[2] != null && typeof args[2] === 'object') {
      childProcessInfo.options = args[2]
    }
  } else if (args[1] != null && typeof args[1] === 'object') {
    childProcessInfo.options = args[1]
  }
  childProcessInfo.shell = shell ||
    childProcessInfo.options?.shell === true ||
    typeof childProcessInfo.options?.shell === 'string'

  return childProcessInfo
}

function wrapChildProcessSyncMethod (shell = false) {
  return function wrapMethod (childProcessMethod) {
    return function () {
      if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const childProcessInfo = normalizeArgs(arguments, shell)

      return childProcessChannel.traceSync(
        childProcessMethod,
        {
          command: childProcessInfo.command,
          shell: childProcessInfo.shell
        },
        this,
        ...arguments)
    }
  }
}

function wrapChildProcessCustomPromisifyMethod (customPromisifyMethod, shell) {
  return function () {
    if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
      return customPromisifyMethod.apply(this, arguments)
    }

    const childProcessInfo = normalizeArgs(arguments, shell)

    return childProcessChannel.tracePromise(
      customPromisifyMethod,
      {
        command: childProcessInfo.command,
        shell: childProcessInfo.shell
      },
      this,
      ...arguments)
  }
}

function wrapChildProcessAsyncMethod (shell = false) {
  return function wrapMethod (childProcessMethod) {
    function wrappedChildProcessMethod () {
      if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const childProcessInfo = normalizeArgs(arguments, shell)

      const innerResource = new AsyncResource('bound-anonymous-fn')
      return innerResource.runInAsyncScope(() => {
        childProcessChannel.start.publish({ command: childProcessInfo.command, shell: childProcessInfo.shell })

        const childProcess = childProcessMethod.apply(this, arguments)
        if (childProcess) {
          let errorExecuted = false

          childProcess.on('error', (e) => {
            errorExecuted = true
            childProcessChannel.error.publish(e)
          })

          childProcess.on('close', (code) => {
            code = code || 0
            if (!errorExecuted && code !== 0) {
              childProcessChannel.error.publish()
            }
            childProcessChannel.asyncEnd.publish({
              command: childProcessInfo.command,
              shell: childProcessInfo.shell,
              result: code
            })
          })
        }

        return childProcess
      })
    }

    if (childProcessMethod[util.promisify.custom]) {
      const wrapedChildProcessCustomPromisifyMethod =
        shimmer.wrap(childProcessMethod[util.promisify.custom],
          wrapChildProcessCustomPromisifyMethod(childProcessMethod[util.promisify.custom]), shell)

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
