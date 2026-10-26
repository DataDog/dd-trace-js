'use strict'

const { MessageChannel } = require('node:worker_threads')

const dc = require('dc-polyfill')

const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

// The loader reports a package once, possibly before dependency telemetry subscribes (the loader handles
// the whole graph before an app that starts the tracer itself runs), so late consumers replay these.
/** @type {string[]} */
const publishedFilenames = []

/**
 * Publishes an ESM module load that the loader observed but did not wrap, so consumers such as
 * dependency telemetry see packages without dd-trace instrumentation too.
 *
 * @param {string} filename Loaded module URL.
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
  port1.on('message', publishModuleLoad)
  // The loader thread outlives short-lived applications; never keep them running.
  port1.unref?.()
  return { data: { moduleLoadPort: port2 }, transferList: [port2] }
}

module.exports = { getLoaderRegisterOptions, getPublishedModuleLoads, publishModuleLoad }
