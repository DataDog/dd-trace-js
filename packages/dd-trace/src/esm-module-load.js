'use strict'

/** @type {string[]} */
let pendingFilenames = []
/** @type {((filename: string) => void) | undefined} */
let moduleLoadHandler

/**
 * @param {string} filename Loaded module URL.
 */
function recordModuleLoad (filename) {
  if (moduleLoadHandler) {
    moduleLoadHandler(filename)
  } else {
    pendingFilenames.push(filename)
  }
}

/**
 * @param {((filename: string) => void) | undefined} handler
 */
function setModuleLoadHandler (handler) {
  moduleLoadHandler = handler
  if (handler) {
    const filenames = pendingFilenames
    pendingFilenames = []
    for (const filename of filenames) {
      handler(filename)
    }
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
  const { MessageChannel } = require('node:worker_threads')
  const { port1, port2 } = new MessageChannel()
  port1.on('message', recordModuleLoad)
  // The loader thread outlives short-lived applications; never keep them running.
  port1.unref?.()
  return { data: { moduleLoadPort: port2 }, transferList: [port2] }
}

module.exports = { getLoaderRegisterOptions, recordModuleLoad, setModuleLoadHandler }
