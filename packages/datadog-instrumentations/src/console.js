'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('./helpers/instrument')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
const methods = ['error', 'warn']
const methodSet = new Set(methods)
const wrappedTargets = new WeakSet()

let callDepth = 0
let configuredGetLogHolder

/**
 * @param {string} method
 * @param {unknown[]} args
 * @param {(() => { dd: object } | undefined) | undefined} getLogHolder
 */
function publishLog (method, args, getLogHolder) {
  if (!logSubmissionCh.hasSubscribers) return

  try {
    const logHolder = (getLogHolder || configuredGetLogHolder)?.()
    if (logHolder) logSubmissionCh.publish({ args, logHolder, method })
  } catch {}
}

/**
 * @param {object} target
 * @param {(() => { dd: object } | undefined) | undefined} [getLogHolder]
 */
function wrapConsole (target, getLogHolder) {
  if (!target || wrappedTargets.has(target)) return

  wrappedTargets.add(target)
  for (const method of methods) {
    if (typeof target[method] !== 'function') continue

    // Global console methods are bound at runtime, so source rewriting cannot intercept them.
    shimmer.wrap(target, method, original => function () {
      const shouldPublish = callDepth++ === 0
      try {
        const result = original.apply(this, arguments)
        if (shouldPublish) publishLog(method, [...arguments], getLogHolder)
        return result
      } finally {
        callDepth--
      }
    })
  }
}

/**
 * @param {{ BufferedConsole?: Function, CustomConsole?: Function }} jestConsole
 * @param {(() => { dd: object } | undefined) | undefined} [getLogHolder]
 */
function wrapJestConsole (jestConsole, getLogHolder) {
  const { BufferedConsole, CustomConsole } = jestConsole

  if (BufferedConsole && !wrappedTargets.has(BufferedConsole)) {
    wrappedTargets.add(BufferedConsole)
    // Jest bundles and exports these adapter classes differently across versions, so wrap their runtime exports.
    shimmer.wrap(BufferedConsole, 'write', original => function (buffer, method, message) {
      const result = original.apply(this, arguments)
      if (methodSet.has(method)) publishLog(method, [message], getLogHolder)
      return result
    })
  }

  if (CustomConsole && !wrappedTargets.has(CustomConsole)) {
    wrappedTargets.add(CustomConsole)
    shimmer.wrap(CustomConsole.prototype, '_logError', original => function (method, message) {
      const result = original.apply(this, arguments)
      if (methodSet.has(method)) publishLog(method, [message], getLogHolder)
      return result
    })
  }
}

configureCh.subscribe(({ getLogHolder } = {}) => {
  configuredGetLogHolder = getLogHolder
  wrapConsole(globalThis.console)
})

module.exports = { wrapConsole, wrapJestConsole }
