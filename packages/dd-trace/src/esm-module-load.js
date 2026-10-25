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

// The loader reports a package once, possibly before dependency telemetry subscribes (the synchronous
// loader resolves the whole graph before the app starts the tracer), so late consumers replay these.
/** @type {string[]} */
const publishedFilenames = []

/**
 * @param {string} filename Resolved module URL reported by the loader thread.
 */
function queueModuleLoad (filename) {
  pendingFilenames.push(filename)
  if (flushTimer === undefined) {
    flushTimer = setTimeout(flushModuleLoads, FLUSH_DELAY_MS)
    flushTimer.unref?.()
    // Short-lived apps can exit before the timer fires. The handlers exist once the tracer started.
    globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers.add(flushModuleLoads)
  }
}

function flushModuleLoads () {
  clearTimeout(flushTimer)
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
  publishedFilenames.push(filename)
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.publish({ filename })
  }
}

/**
 * Returns the ESM module loads published so far, one per package.
 *
 * @returns {string[]}
 */
function getPublishedModuleLoads () {
  return publishedFilenames
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

module.exports = { getLoaderRegisterOptions, getPublishedModuleLoads, publishModuleLoad }
