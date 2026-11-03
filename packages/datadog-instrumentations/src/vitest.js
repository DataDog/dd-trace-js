'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { isTrue } = require('../../dd-trace/src/util')
const { channel } = require('./helpers/instrument')

channel('tracing:orchestrion:@vitest/runner:createTestTask:end').subscribe(({ arguments: args, result: task }) => {
  // Suite options have already been merged here, including overrides equal to ATR's count.
  if (args[1]?.retry !== undefined && task?.meta) {
    task.meta = { ...task.meta, __ddTestOptNativeRetry: true }
  }
})

if (getEnvironmentVariable('DD_VITEST_WORKER') === '1') {
  const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'

  // In no-worker-init mode the main process reports Vitest events from reporter hooks.
  // Loading worker instrumentation here would reintroduce the worker tracer path.
  // eslint-disable-next-line eslint-rules/eslint-process-env
  if (isTrue(process.env[VITEST_NO_WORKER_INIT_ACTIVE_ENV])) return

  require('./vitest-worker')
} else {
  require('./vitest-main')
}
