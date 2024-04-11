const NoopTracer = require('../../dd-trace/src/noop/tracer')
const cypressPlugin = require('./cypress-plugin')

const noopTask = {
  'dd:testSuiteStart': () => {
    return null
  },
  'dd:beforeEach': () => {
    return {}
  },
  'dd:afterEach': () => {
    return null
  },
  'dd:addTags': () => {
    return null
  }
}

module.exports = (on, config) => {
  const tracer = require('../../dd-trace')

  // The tracer was not init correctly for whatever reason (such as invalid DD_SITE)
  if (tracer._tracer instanceof NoopTracer) {
    // We still need to register these tasks or the support file will fail
    return on('task', noopTask)
  }

  cypressPlugin.init(tracer, config)

  on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))
  on('after:spec', cypressPlugin.afterSpec.bind(cypressPlugin))
  on('after:run', cypressPlugin.afterRun.bind(cypressPlugin))
  on('task', cypressPlugin.getTasks())
}
