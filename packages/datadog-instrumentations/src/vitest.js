'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { isTrue } = require('../../dd-trace/src/util')

const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'

if (getEnvironmentVariable('DD_VITEST_WORKER') === '1') {
  // In no-worker-init mode the main process reports Vitest events from reporter hooks.
  // Loading worker instrumentation here would reintroduce the worker tracer path.
  // eslint-disable-next-line eslint-rules/eslint-process-env
  if (isTrue(process.env[VITEST_NO_WORKER_INIT_ACTIVE_ENV])) return

  require('./vitest-worker')
} else {
  require('./vitest-main')
}
