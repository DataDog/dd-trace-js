'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')

if (getEnvironmentVariable('DD_VITEST_WORKER') === '1') {
  require('./vitest-worker')
} else {
  require('./vitest-main')
}
