'use strict'

const { Console } = require('node:console')

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
const methods = ['debug', 'error', 'info', 'log', 'warn']
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
      try {
        if (shouldPublish) {
          logSubmissionCh.publish({ method, args: arguments })
        }
        return original.apply(this, arguments)
      } finally {
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
        logSubmissionCh.publish({ method, args: [message] })
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
