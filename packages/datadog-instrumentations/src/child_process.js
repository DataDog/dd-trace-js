'use strict'

const { errorMonitor } = require('events')
const util = require('util')

const {
  addHook
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
    shell: childProcessInfo.shell,
    abortController: new AbortController()
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
      const context = createContextFromChildProcessInfo(childProcessInfo)

      return childProcessChannel.start.runStores(context, () => {
        try {
          if (context.abortController.signal.aborted) {
            const error = context.abortController.signal.reason || new Error('Aborted')
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
    start.publish(context)

    let result
    if (context.abortController.signal.aborted) {
      result = Promise.reject(context.abortController.signal.reason || new Error('Aborted'))
    } else {
      try {
        result = customPromisifyMethod.apply(this, arguments)
      } catch (error) {
        context.error = error
        error.publish(context)
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

    return Promise.resolve(result).then(resolve, reject)
  }
}

function wrapChildProcessAsyncMethod (ChildProcess, shell = false) {
  return function wrapMethod (childProcessMethod) {
    function wrappedChildProcessMethod () {
      if (!childProcessChannel.start.hasSubscribers || arguments.length === 0) {
        return childProcessMethod.apply(this, arguments)
      }

      const childProcessInfo = normalizeArgs(arguments, shell)

      const context = createContextFromChildProcessInfo(childProcessInfo)
      return childProcessChannel.start.runStores(context, () => {
        let childProcess
        if (context.abortController.signal.aborted) {
          childProcess = new ChildProcess()
          childProcess.on('error', () => {}) // Original method does not crash when non subscribers

          process.nextTick(() => {
            const error = context.abortController.signal.reason || new Error('Aborted')
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

          childProcess.on(errorMonitor, (e) => {
            errorExecuted = true
            context.error = e
            childProcessChannel.error.publish(context)
          })

          childProcess.on('close', (code = 0) => {
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
          value: wrapedChildProcessCustomPromisifyMethod
        })
    }
    return wrappedChildProcessMethod
  }
}
