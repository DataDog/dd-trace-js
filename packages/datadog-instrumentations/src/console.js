'use strict'

const { Console } = require('node:console')

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
// Keep routine test output local while submitting diagnostics that can explain failures.
const methods = ['error', 'warn']
const methodSet = new Set(methods)
const wrappedTargets = new WeakSet()

let callDepth = 0

/** @typedef {{ write: (buffer: unknown, method: string, message: string) => unknown }} JestBufferedConsole */

/**
 * @param {Record<string, unknown> | undefined} target
 * @returns {void}
 */
function wrapConsole (target) {
  if (!target || wrappedTargets.has(target)) return

  wrappedTargets.add(target)
  for (const method of methods) {
    if (typeof target[method] !== 'function') continue

    // Console methods are bound onto instances at runtime, so Orchestrion cannot
    // rewrite every receiver that test frameworks create or replace.
    shimmer.wrap(target, method, original => function () {
      const shouldPublish = callDepth++ === 0 && logSubmissionCh.hasSubscribers
      let stream
      let writeDescriptor
      let originalWrite
      let message
      let wrappedWrite

      if (shouldPublish) {
        try {
          const receiver = this?._stderr ? this : target
          stream = receiver?._stderr
          originalWrite = stream?.write
          if (typeof originalWrite === 'function') {
            writeDescriptor = Object.getOwnPropertyDescriptor(stream, 'write')
            wrappedWrite = function (chunk) {
              if (typeof chunk === 'string') message = chunk
              return originalWrite.apply(this, arguments)
            }
            stream.write = wrappedWrite
            if (stream.write !== wrappedWrite) wrappedWrite = undefined
          }
        } catch {
          wrappedWrite = undefined
        }
      }

      try {
        const result = original.apply(this, arguments)
        if (wrappedWrite && message !== undefined) {
          if (message.endsWith('\n')) message = message.slice(0, -1)
          logSubmissionCh.publish({ method, message })
        }
        return result
      } finally {
        if (wrappedWrite) {
          try {
            if (stream.write === wrappedWrite) {
              if (writeDescriptor) {
                Object.defineProperty(stream, 'write', writeDescriptor)
              } else {
                delete stream.write
              }
            }
          } catch {}
        }
        callDepth--
      }
    })
  }
}

/**
 * @param {JestBufferedConsole | undefined} BufferedConsole
 * @returns {void}
 */
function wrapJestBufferedConsole (BufferedConsole) {
  if (!BufferedConsole || wrappedTargets.has(BufferedConsole)) return

  wrappedTargets.add(BufferedConsole)
  // Jest buffers records through this static method without calling Node's
  // Console methods. Wrapping it also preserves Jest's user-facing callsite.
  shimmer.wrap(BufferedConsole, 'write', original => function (buffer, method, message) {
    const shouldPublish = callDepth++ === 0 && methodSet.has(method) && logSubmissionCh.hasSubscribers
    try {
      if (shouldPublish) {
        logSubmissionCh.publish({ method, message })
      }
      return original.apply(this, arguments)
    } finally {
      callDepth--
    }
  })
}

configureCh.subscribe(() => {
  // The global console has bound own methods, while Console.prototype covers
  // instances that are created after log submission is enabled.
  wrapConsole(globalThis.console)
  wrapConsole(Console.prototype)
})

module.exports = { wrapConsole, wrapJestBufferedConsole }
