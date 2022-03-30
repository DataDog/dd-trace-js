const path = require('path')
const tracer = require('../packages/dd-trace')
const { ORIGIN_KEY } = require('../packages/dd-trace/src/constants')
const { mochaHook } = require('../packages/datadog-instrumentations/src/mocha')
const { wrapRun } = require('../packages/datadog-instrumentations/src/cucumber')

const options = {
  startupLogs: false,
  tags: {
    [ORIGIN_KEY]: 'ciapp-test'
  }
}

if (process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED && (process.env.DATADOG_API_KEY || process.env.DD_API_KEY)) {
  options.experimental = {
    exporter: 'datadog'
  }
}

// TODO: remove this in a later major version since we now recommend using
// `NODE_OPTIONS='-r dd-trace/ci/init'`.
for (const filename in require.cache) {
  const id = filename.split(path.sep).join('/')

  if (id.includes('/node_modules/mocha/lib/runner.js')) {
    mochaHook(require.cache[filename].exports)
  } else if (id.includes('/node_modules/@cucumber/cucumber/lib/runtime/pickle_runner.js')) {
    wrapRun(require.cache[filename].exports, false)
  } else if (id.includes('/node_modules/@cucumber/cucumber/lib/runtime/test_case_runner.js')) {
    wrapRun(require.cache[filename].exports, true)
  }
}

tracer.init(options)

tracer.use('fs', false)

module.exports = tracer
