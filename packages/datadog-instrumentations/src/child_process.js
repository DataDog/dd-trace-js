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
      shimmer.massWrap(childProcess, execAsyncMethods, wrapChildProcessAsyncMethod(childProcess.ChildProcess))
      // shimmer.massWrap(childProcess, execSyncMethods, wrapChildProcessSyncMethod())
      shimmer.wrap(childProcess, 'execSync', wrapChildProcessSyncMethod('execSync', true))
      shimmer.wrap(childProcess, 'execFileSync', wrapChildProcessSyncMethod('execFileSync'))
      shimmer.wrap(childProcess, 'spawnSync', wrapChildProcessSyncMethod('spawnSync'))
    }

    return childProcess
  })
})

function normalizeArgs (args, shell) {
  const childProcessInfo = {
    command: args[0],
    file: args[0],
  }

  if (Array.isArray(args[1])) {
    childProcessInfo.command = childProcessInfo.command + ' ' + args[1].join(' ')
    childProcessInfo.fileArgs = args[1]

    if (args[2] !== null && typeof args[2] === 'object') {
      childProcessInfo.options = args[2]
    }
  } else if (args[1] !== null && typeof args[1] === 'object') {
    childProcessInfo.options = args[1]
  }

  childProcessInfo.shell = shell ||
    childProcessInfo.options?.shell === true ||
    typeof childProcessInfo.options?.shell === 'string'

  return childProcessInfo
}

function wrapChildProcessSyncMethod (methodName, shell = false) {
  return function wrapMethod (childProcessMethod) {
    return function () {
      if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const childProcessInfo = normalizeArgs(arguments, shell)

      const innerResource = new AsyncResource('bound-anonymous-fn')
      return innerResource.runInAsyncScope(() => {
        const context = {
          command: childProcessInfo.command,
          file: childProcessInfo.file,
          shell: childProcessInfo.shell
        }
        if (childProcessInfo.fileArgs) {
          context.fileArgs = childProcessInfo.fileArgs
        }
        const abortController = new AbortController()

        childProcessChannel.start.publish({ ...context, abortController })

        try {
          if (abortController.signal.aborted) {
            const error = abortController.signal.reason || new Error('Aborted')
            // expected results on error are different in each method
            switch (methodName) {
              case 'execFileSync':
              case 'execSync':
                throw error
              case 'spawnSync':
                return {
                  error,
                  status: null,
                  signal: null,
                  output: null,
                  stdout: null,
                  stderr: null,
                  pid: 0
                }
            }
          }

          const result = childProcessMethod.apply(this, arguments)
          context.result = result

          return result
        } catch (err) {
          context.error = err
          childProcessChannel.error.publish(context)

          throw err
        } finally {
          childProcessChannel.end.publish(context)
        }
      })
    }
  }
}

function wrapChildProcessCustomPromisifyMethod (customPromisifyMethod, shell) {
  return function () {
    if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
      return customPromisifyMethod.apply(this, arguments)
    }

    const childProcessInfo = normalizeArgs(arguments, shell)

    const context = {
      command: childProcessInfo.command,
      file: childProcessInfo.file,
      shell: childProcessInfo.shell
    }
    if (childProcessInfo.fileArgs) {
      context.fileArgs = childProcessInfo.fileArgs
    }

    return childProcessChannel.tracePromise(
      customPromisifyMethod,
      context,
      this,
      ...arguments)
  }
}

function wrapChildProcessAsyncMethod (ChildProcess, shell = false) {
  return function wrapMethod (childProcessMethod) {
    function wrappedChildProcessMethod () {
      if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const childProcessInfo = normalizeArgs(arguments, shell)

      const cb = arguments[arguments.length - 1]
      if (typeof cb === 'function') {
        const callbackResource = new AsyncResource('bound-anonymous-fn')
        arguments[arguments.length - 1] = callbackResource.bind(cb)
      }

      const innerResource = new AsyncResource('bound-anonymous-fn')
      return innerResource.runInAsyncScope(() => {
        const abortController = new AbortController()
        const { command, file, shell, fileArgs } = childProcessInfo
        const context = {
          command,
          file,
          shell
        }
        if (fileArgs) {
          context.fileArgs = fileArgs
        }

        childProcessChannel.start.publish({ ...context, abortController })

        let childProcess
        if (abortController.signal.aborted) {
          childProcess = new ChildProcess()
          process.nextTick(() => {
            const error = abortController.signal.reason || new Error('Aborted')
            childProcess.emit('error', error)
            const cb = arguments[arguments.length - 1]
            if (typeof cb === 'function') {
              cb(error)
            }
            childProcess.emit('close')
          })
        } else {
          childProcess = childProcessMethod.apply(this, arguments)
        }

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
              ...context,
              result: code
            })
          })
        }

        return childProcess
      })
    }

    if (childProcessMethod[util.promisify.custom]) {
      const wrapedChildProcessCustomPromisifyMethod =
        shimmer.wrapFunction(childProcessMethod[util.promisify.custom],
          promisify => wrapChildProcessCustomPromisifyMethod(promisify, shell))

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
