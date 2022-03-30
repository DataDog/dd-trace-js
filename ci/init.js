const path = require('path')
const tracer = require('../packages/dd-trace')
const { ORIGIN_KEY } = require('../packages/dd-trace/src/constants')
const { mochaHook } = require('../packages/datadog-instrumentations/src/mocha')
const { pickleHook, testCaseHook } = require('../packages/datadog-instrumentations/src/cucumber')

const options = {
  startupLogs: false,
  tags: {
    [ORIGIN_KEY]: 'ciapp-test'
  }
}

// TODO: remove this in a later major version since we now recommend using
// `NODE_OPTIONS='-r dd-trace/ci/init'`.
try {
  for (const filename in require.cache) {
    const cache = require.cache[filename]
    const id = filename.split(path.sep).join('/')

    if (id.includes('/node_modules/mocha/lib/runner.js')) {
      cache.exports = mochaHook(cache.exports)
    } else if (id.includes('/node_modules/@cucumber/cucumber/lib/runtime/pickle_runner.js')) {
      cache.exports = pickleHook(cache.exports)
    } else if (id.includes('/node_modules/@cucumber/cucumber/lib/runtime/test_case_runner.js')) {
      cache.exports = testCaseHook(cache.exports)
    }
  }
} catch (e) {
  // ignore error and let the tracer initialize anyway
}

tracer.init(options)

tracer.use('fs', false)

module.exports = tracer
