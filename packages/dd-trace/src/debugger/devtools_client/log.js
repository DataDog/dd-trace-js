'use strict'

/** @typedef {'error'|'warn'|'info'|'debug'} Level */
/** @typedef {(...args: unknown[]) => void} LogFn */
/** @typedef {Record<Level, LogFn>} Logger */

const { workerData } = require('node:worker_threads')

// For testing purposes, we allow `workerData` to be undefined and fallback to a default config
const { config: { debug = false, logLevel } = {}, logPort } = workerData ?? {}

/** @type {Level[]} */
const LEVELS = ['error', 'warn', 'info', 'debug']
const on = (level, ...args) => {
  if (typeof args[0] === 'function') {
    args = [args[0]()]
  }
  logPort.postMessage({ level, args })
}
const off = () => {}

const threshold = LEVELS.indexOf(logLevel)

/** @type {Logger} */
module.exports = Object.fromEntries(
  LEVELS.map(level => [
    level,
    debug && threshold >= LEVELS.indexOf(level) ? on.bind(null, level) : off
  ])
)
