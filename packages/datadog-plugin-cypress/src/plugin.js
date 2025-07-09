'use strict'

const NoopTracer = require('../../dd-trace/src/noop/tracer')
const cypressPlugin = require('./cypress-plugin')
const satisfies = require('semifies')
const { DD_MAJOR } = require('../../../version')

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

module.exports = function CypressPlugin (on, config) {
  const tracer = require('../../dd-trace')

  if (satisfies(config.version, '<10.2.0')) {
    if (DD_MAJOR >= 6) {
      // eslint-disable-next-line no-console
      console.error(
        'ERROR: dd-trace v6 has deleted support for Cypress<10.2.0.'
      )
      on('task', noopTask)
      return config
    }

    // console.warn does not seem to work in cypress, so using console.log instead
    // eslint-disable-next-line no-console
    console.log(
      'WARNING: dd-trace support for Cypress<10.2.0 is deprecated' +
      ' and will not be supported in future versions of dd-trace.'
    )
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
