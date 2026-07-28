'use strict'

const {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
} = require('../../../dd-trace/src/ci-visibility/exporters/test-worker/webdriverio')

module.exports = {
  CONFIGURATION_REQUEST: 'dd:test-optimization:webdriverio:configuration:request',
  CONFIGURATION_RESPONSE: 'dd:test-optimization:webdriverio:configuration:response',
  createWebdriverioWorkerMessage,
  SUITE_FINISH: 'dd:test-optimization:webdriverio:test-suite:finish',
  WORKER_READY: 'dd:test-optimization:webdriverio:worker:ready',
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
}
