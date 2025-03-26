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

const names = ['child_process', 'node:child_process']

// child_process and node:child_process returns the same object instance, we only want to add hooks once
let patched = false

function throwSyncError (error) {
  throw error
}

function returnSpawnSyncError (error, context) {
  context.result = {
    error,
    status: null,
    signal: null,
    output: null,
    stdout: null,
    stderr: null,
    pid: 0
  }

  return context.result
}

names.forEach(name => {
  addHook({ name }, childProcess => {
    if (!patched) {
      patched = true
      shimmer.massWrap(childProcess, execAsyncMethods, wrapChildProcessAsyncMethod(childProcess.ChildProcess))
      shimmer.wrap(childProcess, 'execSync', wrapChildProcessSyncMethod(throwSyncError, true))
      shimmer.wrap(childProcess, 'execFileSync', wrapChildProcessSyncMethod(throwSyncError))
      shimmer.wrap(childProcess, 'spawnSync', wrapChildProcessSyncMethod(returnSpawnSyncError))
    }

    return childProcess
  })
})

function normalizeArgs (args, shell) {
  const childProcessInfo = {
    command: args[0],
    file: args[0]
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

function createContextFromChildProcessInfo (childProcessInfo) {
  const context = {
    command: childProcessInfo.command,
    file: childProcessInfo.file,
    shell: childProcessInfo.shell
  }

  if (childProcessInfo.fileArgs) {
    context.fileArgs = childProcessInfo.fileArgs
  }

  return context
}

function wrapChildProcessSyncMethod (returnError, shell = false) {
  return function wrapMethod (childProcessMethod) {
    return function () {
      if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const childProcessInfo = normalizeArgs(arguments, shell)

      const innerResource = new AsyncResource('bound-anonymous-fn')
      return innerResource.runInAsyncScope(() => {
        const context = createContextFromChildProcessInfo(childProcessInfo)
        const abortController = new AbortController()

        childProcessChannel.start.publish({ ...context, abortController })

        try {
          if (abortController.signal.aborted) {
            const error = abortController.signal.reason || new Error('Aborted')
            // expected behaviors on error are different
            return returnError(error, context)
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

    const context = createContextFromChildProcessInfo(childProcessInfo)

    const { start, end, asyncStart, asyncEnd, error } = childProcessChannel
    const abortController = new AbortController()

    start.publish({
      ...context,
      abortController
    })

    let result
    if (abortController.signal.aborted) {
      result = Promise.reject(abortController.signal.reason || new Error('Aborted'))
    } else {
      try {
        result = customPromisifyMethod.apply(this, arguments)
      } catch (error) {
        error.publish({ ...context, error })
        throw error
      } finally {
        end.publish(context)
      }
    }

    function reject (err) {
      context.error = err
      error.publish(context)
      asyncStart.publish(context)

      asyncEnd.publish(context)
      return Promise.reject(err)
    }

    function resolve (result) {
      context.result = result
      asyncStart.publish(context)

      asyncEnd.publish(context)
      return result
    }

    return Promise.prototype.then.call(result, resolve, reject)
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
        const context = createContextFromChildProcessInfo(childProcessInfo)
        const abortController = new AbortController()

        childProcessChannel.start.publish({ ...context, abortController })

        let childProcess
        if (abortController.signal.aborted) {
          childProcess = new ChildProcess()
          childProcess.on('error', () => {}) // Original method does not crash when non subscribers

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
