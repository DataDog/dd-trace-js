'use strict'

const { MessageChannel } = require('node:worker_threads')

const dc = require('dc-polyfill')

const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

// Reports from the loader thread arrive one event loop turn apart. Publishing them together lets
// dependency telemetry send one request for the module graph instead of one per package.
const FLUSH_DELAY_MS = 100

/** @type {string[]} */
let pendingFilenames = []
let flushTimer

/**
 * @param {string} filename Resolved module URL reported by the loader thread.
 */
function queueModuleLoad (filename) {
  pendingFilenames.push(filename)
  if (flushTimer === undefined) {
    flushTimer = setTimeout(flushModuleLoads, FLUSH_DELAY_MS)
    flushTimer.unref?.()
  }
}

function flushModuleLoads () {
  const filenames = pendingFilenames
  pendingFilenames = []
  flushTimer = undefined
  for (const filename of filenames) {
    publishModuleLoad(filename)
  }
}

/**
 * Publishes an ESM module load that the loader observed but did not wrap, so consumers such as
 * dependency telemetry see packages without dd-trace instrumentation too.
 *
 * @param {string} filename Resolved module URL.
 */
function publishModuleLoad (filename) {
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.publish({ filename })
  }
}

/**
 * Builds the `module.register` options that hand the asynchronous loader thread a port to report
 * unwrapped module loads back to the application thread.
 *
 * @returns {{ data: { moduleLoadPort: import('node:worker_threads').MessagePort },
 *   transferList: import('node:worker_threads').MessagePort[] }}
 */
function getLoaderRegisterOptions () {
  const { port1, port2 } = new MessageChannel()
  port1.on('message', queueModuleLoad)
  // The loader thread outlives short-lived applications; never keep them running.
  port1.unref?.()
  return { data: { moduleLoadPort: port2 }, transferList: [port2] }
}

module.exports = { getLoaderRegisterOptions, publishModuleLoad }
