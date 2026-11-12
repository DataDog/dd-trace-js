'use strict'

const { runCoverageSuite } = require('../coverage/run-suite')

// Each dependency version needs an isolated process because the suites use process-global sandboxes.
const versions = process.env.TEST_OPTIMIZATION_PARALLEL_VITEST_VERSIONS
  ?.split(',').filter(Boolean)
const environments = versions?.length
  ? versions.map(version => ({
    MOCHA_JUNIT_REPORT_SUFFIX: `vitest-${version}`,
    VITEST_VERSION: version,
  }))
  : undefined

runCoverageSuite(environments)
