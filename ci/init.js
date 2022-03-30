const tracer = require('../packages/dd-trace')
const { ORIGIN_KEY } = require('../packages/dd-trace/src/constants')

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

tracer.init(options)

tracer.use('fs', false)

// TODO: remove this in a later major version since we now recommend
// `NODE_OPTIONS='-r dd-trace/ci/init'` instead of `mocha -r dd-trace/ci/init`.
tracer.mochaGlobalSetup = function () {
  const { mochaHook } = require('../packages/datadog-instrumentations/src/mocha')
  mochaHook(this.constructor)
}

module.exports = tracer
