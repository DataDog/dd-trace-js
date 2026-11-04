'use strict'

module.exports = {
  tags: 'test_optimization_enabled:true',
  errorCodes: new Set([
    'ERR_DD_TEST_OPTIMIZATION_QUEUE_FULL',
    'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT',
    'ERR_DD_TEST_OPTIMIZATION_REQUEST_TIMEOUT',
    'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT',
  ]),
}
