'use strict'

const WEBDRIVERIO_WORKER_ENV = '_DD_TEST_OPTIMIZATION_WEBDRIVERIO_WORKER'
const WEBDRIVERIO_WORKER_EVENT = 'workerEvent'
const WEBDRIVERIO_WORKER_ORIGIN = 'datadog'

/**
 * Wraps an internal worker payload in the event WebdriverIO reserves for worker messages.
 *
 * @param {unknown} args
 * @returns {{args: unknown, name: string, origin: string}}
 */
function createWebdriverioWorkerMessage (args) {
  return {
    origin: WEBDRIVERIO_WORKER_ORIGIN,
    name: WEBDRIVERIO_WORKER_EVENT,
    args,
  }
}

module.exports = {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
}
