'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { isTrue } = require('../../dd-trace/src/util')

const isWorker = getEnvironmentVariable('DD_VITEST_WORKER') === '1'
const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'

// No-worker setup captures declarations directly, without registering instrumentation hooks.
// eslint-disable-next-line eslint-rules/eslint-process-env
if (isWorker && isTrue(process.env[VITEST_NO_WORKER_INIT_ACTIVE_ENV])) return

const { channel } = require('./helpers/instrument')
require('./vitest-test-annotations')

channel('tracing:orchestrion:@vitest/runner:createTestTask:end').subscribe(({ arguments: args, result: task }) => {
  // Suite options have already been merged here, including overrides equal to ATR's count.
  if (args[1]?.retry !== undefined && task?.meta) {
    task.meta = { ...task.meta, __ddTestOptNativeRetry: true }
  }
})

if (isWorker) {
  require('./vitest-worker')
} else {
  require('./vitest-main')
}
