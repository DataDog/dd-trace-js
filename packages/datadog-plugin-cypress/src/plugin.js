'use strict'

const NoopTracer = require('../../dd-trace/src/noop/tracer')
const satisfies = require('../../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../../version')
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
  },
}

module.exports = function CypressPlugin (on, config) {
  const tracer = require('../../dd-trace')

  if (DD_MAJOR >= 6 && satisfies(config.version, '<12.0.0')) {
    // eslint-disable-next-line no-console
    console.error(
      'ERROR: dd-trace v6 has deleted support for Cypress<12.0.0.'
    )
    on('task', noopTask)
    return config
  }

  // The tracer was not init correctly for whatever reason (such as invalid DD_SITE)
  if (tracer._tracer instanceof NoopTracer) {
    // We still need to register these tasks or the support file will fail
    on('task', noopTask)
    return config
  }

  on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))
  on('after:spec', cypressPlugin.afterSpec.bind(cypressPlugin))
  on('after:run', cypressPlugin.afterRun.bind(cypressPlugin))
  on('task', cypressPlugin.getTasks())

  return cypressPlugin.init(tracer, config)
}
