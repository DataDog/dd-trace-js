'use strict'

const { randomUUID } = require('node:crypto')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const { PRE_INSTRUMENTED_ROOT, getSandboxNycPaths } = require('./runtime')

const EXIT_SIGNALS = ['SIGBREAK', 'SIGHUP', 'SIGINT', 'SIGTERM']
const HIDDEN_PREFIX = `${PRE_INSTRUMENTED_ROOT}/`

// Hide pre-instrumented dd-trace entries from enumeration (jest etc.) while keeping direct
// access intact so `cov_*` counters still increment. Returns the raw backing store.
function installCoverageShield () {
  const existing = globalThis.__coverage__
  const raw = existing && typeof existing === 'object' ? existing : {}
  globalThis.__coverage__ = new Proxy(raw, {
    ownKeys (target) {
      return Reflect.ownKeys(target)
        .filter(key => typeof key !== 'string' || !key.startsWith(HIDDEN_PREFIX))
    },
    getOwnPropertyDescriptor (target, key) {
      if (typeof key === 'string' && key.startsWith(HIDDEN_PREFIX)) return undefined
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  return raw
}

/**
 * Register `handler` as a `process.on('exit', ...)` listener and re-register it whenever
 * a new `'exit'` listener is added so it always runs last. The bootstrap loads via
 * `NODE_OPTIONS=-r` before anything else, so without this dance our flush is the first
 * `'exit'` listener and every later listener (plugin teardown, mocha-side flushes) loses
 * the counter increments it touches in dd-trace.
 *
 * @param {() => void} handler
 * @returns {void}
 */
function installLastExitHandler (handler) {
  const originalOn = process.on.bind(process)
  const originalAddListener = process.addListener.bind(process)
  const originalPrependListener = process.prependListener.bind(process)
  const originalRemoveListener = process.removeListener.bind(process)

  originalOn('exit', handler)

  function moveToEnd () {
    originalRemoveListener('exit', handler)
    originalOn('exit', handler)
  }

  function wrap (register) {
    return function (event, listener) {
      const result = register(event, listener)
      if (event === 'exit' && listener !== handler) moveToEnd()
      return result
    }
  }

  process.on = wrap(originalOn)
  process.addListener = wrap(originalAddListener)
  process.prependListener = wrap(originalPrependListener)
}

/**
 * @param {string} coverageRoot
 * @returns {void}
 */
function installPreInstrumentedWriter (coverageRoot) {
  const uuid = randomUUID()
  const { tempDir } = getSandboxNycPaths(coverageRoot)
  mkdirSync(tempDir, { recursive: true })

  const outFile = path.join(tempDir, `${uuid}.json`)
  process.env.NYC_PROCESS_ID = uuid

  const rawCoverage = installCoverageShield()

  let flushed = false
  const flush = () => {
    if (flushed) return
    flushed = true
    try {
      writeFileSync(outFile, JSON.stringify(rawCoverage))
    } catch {}
  }

  installLastExitHandler(flush)
  for (const signal of EXIT_SIGNALS) {
    process.once(signal, () => {
      flush()
      process.kill(process.pid, signal)
    })
  }
}

module.exports = { installCoverageShield, installLastExitHandler, installPreInstrumentedWriter }
