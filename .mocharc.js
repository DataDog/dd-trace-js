'use strict'

// Bump default timeout under NYC / the integration coverage harness; require-hook overhead
// can push otherwise-fast tests past 5s without indicating a real regression.
// eslint-disable-next-line eslint-rules/eslint-process-env
const coverageActive = Boolean(process.env.NYC_CONFIG || process.env.DD_TRACE_INTEGRATION_COVERAGE_ROOT)

module.exports = {
  allowUncaught: true,
  color: true,
  exit: true,
  timeout: coverageActive ? 7500 : 5000,
  require: ['packages/dd-trace/test/setup/mocha.js'],
  reporter: 'mocha-multi-reporters',
  reporterOption: [
    'configFile=.mochamultireporterrc.js',
  ],
}
