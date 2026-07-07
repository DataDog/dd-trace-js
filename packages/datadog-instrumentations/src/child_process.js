'use strict'

const { errorMonitor } = require('events')
const util = require('util')

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')
const NativePromise = Promise

// ignored exec method because it calls to execFile directly
const execAsyncMethods = ['execFile', 'spawn', 'fork']

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
    pid: 0,
  }

  return context.result
}

addHook({ name: 'child_process' }, childProcess => {
  shimmer.massWrap(childProcess, execAsyncMethods, wrapChildProcessAsyncMethod(childProcess.ChildProcess))
  shimmer.wrap(childProcess, 'execSync', wrapChildProcessSyncMethod(throwSyncError, true))
  shimmer.wrap(childProcess, 'execFileSync', wrapChildProcessSyncMethod(throwSyncError))
  shimmer.wrap(childProcess, 'spawnSync', wrapChildProcessSyncMethod(returnSpawnSyncError))

  return childProcess
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

function createContextFromChildProcessInfo (childProcessInfo) {
  const context = {
    command: childProcessInfo.command,
    file: childProcessInfo.file,
    shell: childProcessInfo.shell,
    abortController: new AbortController(),
  }

  if (childProcessInfo.fileArgs) {
    context.fileArgs = childProcessInfo.fileArgs
  }

  return context
}

function wrapChildProcessSyncMethod (returnError, shell = false) {
  return function wrapMethod (childProcessMethod) {
    return function (...args) {
      if (!childProcessChannel.start.hasSubscribers || args.length === 0) {
        return childProcessMethod.apply(this, args)
      }

      const callArgs = [...args]
      const childProcessInfo = normalizeArgs(callArgs, shell)
      const context = createContextFromChildProcessInfo(childProcessInfo)
      context.callArgs = callArgs

      return childProcessChannel.start.runStores(context, () => {
        try {
          if (context.abortController.signal.aborted) {
            const error = context.abortController.signal.reason || new Error('Aborted')
            // expected behaviors on error are different
            return returnError(error, context)
          }

          const result = childProcessMethod.apply(this, context.callArgs)
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
  return function (...args) {
    if (!childProcessChannel.start.hasSubscribers || args.length === 0) {
      return customPromisifyMethod.apply(this, args)
    }

    const callArgs = [...args]
    const childProcessInfo = normalizeArgs(callArgs, shell)

    const context = createContextFromChildProcessInfo(childProcessInfo)
    context.callArgs = callArgs

    return childProcessChannel.tracePromise(function () {
      if (context.abortController.signal.aborted) {
        return NativePromise.reject(context.abortController.signal.reason || new Error('Aborted'))
      }

      return customPromisifyMethod.apply(this, context.callArgs)
    }, context, this)
  }
}

function wrapChildProcessAsyncMethod (ChildProcess, shell = false) {
  return function wrapMethod (childProcessMethod) {
    function wrappedChildProcessMethod (...args) {
      if (!childProcessChannel.start.hasSubscribers || args.length === 0) {
        return childProcessMethod.apply(this, args)
      }

      const callArgs = [...args]
      const childProcessInfo = normalizeArgs(callArgs, shell)

      const context = createContextFromChildProcessInfo(childProcessInfo)
      context.callArgs = callArgs
      return childProcessChannel.start.runStores(context, () => {
        let childProcess
        if (context.abortController.signal.aborted) {
          childProcess = new ChildProcess()
          childProcess.on('error', () => {}) // Original method does not crash when non subscribers

          process.nextTick(() => {
            const error = context.abortController.signal.reason || new Error('Aborted')
            childProcess.emit('error', error)

            const cb = context.callArgs[context.callArgs.length - 1]
            if (typeof cb === 'function') {
              cb(error)
            }

            childProcess.emit('close')
          })
        } else {
          childProcess = childProcessMethod.apply(this, context.callArgs)
        }

        if (childProcess) {
          let errorExecuted = false

          childProcess.on(errorMonitor, (e) => {
            errorExecuted = true
            context.error = e
            childProcessChannel.error.publish(context)
          })

          childProcess.once('close', (code = 0) => {
            if (!errorExecuted && code !== 0) {
              childProcessChannel.error.publish(context)
            }
            context.result = code
            childProcessChannel.asyncEnd.publish(context)
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
          value: wrapedChildProcessCustomPromisifyMethod,
        })
    }
    return wrappedChildProcessMethod
  }
}
