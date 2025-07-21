'use strict'

const { workerData } = require('node:worker_threads')

// For testing purposes, we allow `workerData` to be undefined and fallback to a default config
const { config: { debug, logLevel }, logPort } = workerData ?? { config: { debug: false } }

const LEVELS = ['error', 'warn', 'info', 'debug']
const on = (level, ...args) => {
  if (typeof args[0] === 'function') {
    args = [args[0]()]
  }
  logPort.postMessage({ level, args })
}
const off = () => {}

for (const level of LEVELS) {
  module.exports[level] = debug && LEVELS.indexOf(logLevel) >= LEVELS.indexOf(level) ? on.bind(null, level) : off
}
