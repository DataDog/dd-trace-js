'use strict'

require('./mocha-hooks')

if (process.env.CI) {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const reportDir = path.join(os.tmpdir(), 'node-reports')
  fs.mkdirSync(reportDir, { recursive: true })
  process.report.reportOnFatalError = true
  process.report.reportOnUncaughtException = true
  process.report.directory = reportDir
}

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

// If this is a release PR, set the SSI variables.
if (/^v\d+\.x$/.test(process.env.GITHUB_BASE_REF || '')) {
  process.env.DD_INJECTION_ENABLED = 'true'
  process.env.DD_INJECT_FORCE = 'true'
}

// Ensure the global dd-trace symbol is always defined, even if the tracer is not loaded.
if (!globalThis[Symbol.for('dd-trace')]) {
  const object = {
    beforeExitHandlers: new Set(),
  }

  Object.defineProperty(globalThis, Symbol.for('dd-trace'), {
    value: object,
    enumerable: false,
    configurable: true, // Allow this to be overridden by loading the tracer
    writable: false,
  })

  process.once('beforeExit', function testBeforeExit () {
    // Only run the beforeExit handlers if the object is still the same.
    // That way we run the original beforeExit handler if it was added after this one.
    if (globalThis[Symbol.for('dd-trace')] === object) {
      for (const handler of globalThis[Symbol.for('dd-trace')].beforeExitHandlers) {
        handler()
      }
    }
  })
}

// Lower max listeners to notice when we add too many listeners early.
// Override per-test, if absolutely necessary.
require('events').defaultMaxListeners = 6

// Warnings that should not be thrown
const warningExceptions = new Set([
  // Node.js core warnings. Ignore them.
  'OutgoingMessage.prototype._headers is deprecated',
  "Access to process.binding('http_parser') is deprecated.",
  '`url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG ' +
    'URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.',
  'The `punycode` module is deprecated. Please use a userland alternative instead.',
  // TODO: We should not be throwing warnings in the first place. Fix the following warnings instead.
  "Mongoose: mpromise (mongoose's default promise library) is deprecated, plug in your own promise library instead: http://mongoosejs.com/docs/promises.html",
  'collection.count is deprecated, and will be removed in a future version. ' +
    'Use Collection.countDocuments or Collection.estimatedDocumentCount instead',
])

const temporaryWarningExceptions = new Set()
const originalAdd = temporaryWarningExceptions.add.bind(temporaryWarningExceptions)
/**
 * Add a warning to the temporary warning exceptions. It will be removed after 1ms if it is not emitted.
 *
 * @param {string} warning
 */
temporaryWarningExceptions.add = (warning) => {
  setTimeout(() => {
    temporaryWarningExceptions.delete(warning)
  }, 1)
  return originalAdd(warning)
}

// Suppress Node's HTTP keep-alive `socketErrorListener` leak (introduced by
// https://github.com/nodejs/node/pull/61770; fix at
// https://github.com/nodejs/node/pull/62872 not yet released in v24.x). Bump
// the leaking socket's limit and drop the warning before stderr or the
// `'warning'` event sees it, so real leaks still throw below.
const originalEmitWarning = process.emitWarning
process.emitWarning = function patchedEmitWarning (warning, ...args) {
  if (warning?.name === 'MaxListenersExceededWarning' && isNodeHttpSocketLeak(warning)) {
    warning.emitter.setMaxListeners(0)
    return
  }
  return originalEmitWarning.call(this, warning, ...args)
}

process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    throw warning
  }
  if (temporaryWarningExceptions.has(warning.message)) {
    temporaryWarningExceptions.delete(warning.message)
    return
  }
  if (warning.name === 'DeprecationWarning' && (
    !warningExceptions.has(warning.message) &&
    !warning.message.includes(' DD_') && // Ignore DD environment warnings
    !warning.message.includes("Invalid 'main' field in ") && // This is always a library warning
    !warning.message.includes('Mongoose:') // Too many warnings from Mongoose...
  )) {
    throw warning
  }
})

/**
 * Detect the Node.js HTTP keep-alive socket error listener leak by its only
 * stable signature: two or more listeners named `socketErrorListener` on the
 * same emitter for event `error`. Once the upstream fix ships the duplicates
 * disappear and this returns false again, so real leaks resume throwing.
 *
 * @param {Error & { emitter?: NodeJS.EventEmitter, type?: string }} warning
 * @returns {boolean}
 */
function isNodeHttpSocketLeak (warning) {
  if (warning.type !== 'error' || typeof warning.emitter?.listeners !== 'function') {
    return false
  }
  let count = 0
  for (const listener of warning.emitter.listeners('error')) {
    if (listener.name === 'socketErrorListener' && ++count > 1) {
      return true
    }
  }
  return false
}

// Make this file a module for type-aware tooling. It is intentionally imported
// for side effects only.
module.exports = {
  temporaryWarningExceptions,
}
