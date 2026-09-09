'use strict'

const NoopTracer = require('../../dd-trace/src/noop/tracer')
const satisfies = require('../../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../../version')
const cypressPlugin = require('./cypress-plugin')
const { manualPluginOwner } = require('./finalization')

const DD_CYPRESS_AFTER_SPEC_HANDLER = Symbol.for('dd-trace.cypress.after-spec.handler')
const DD_CYPRESS_AFTER_RUN_HANDLER = Symbol.for('dd-trace.cypress.after-run.handler')
const DD_CYPRESS_TASK_HANDLER = Symbol.for('dd-trace.cypress.task.handler')
const DD_CYPRESS_NOOP_TASK_HANDLER = Symbol.for('dd-trace.cypress.noop-task.handler')

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
  [DD_CYPRESS_NOOP_TASK_HANDLER]: true,
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
  on('after:screenshot', cypressPlugin.getAfterScreenshotHandler())
  const afterSpecHandler = cypressPlugin.afterSpec.bind(cypressPlugin)
  afterSpecHandler[DD_CYPRESS_AFTER_SPEC_HANDLER] = true
  on('after:spec', afterSpecHandler)
  const afterRunHandler = cypressPlugin.afterRun.bind(cypressPlugin)
  afterRunHandler[DD_CYPRESS_AFTER_RUN_HANDLER] = true
  on('after:run', afterRunHandler)
  const taskHandler = cypressPlugin.getTasks()
  taskHandler[DD_CYPRESS_TASK_HANDLER] = manualPluginOwner
  on('task', taskHandler)

  return cypressPlugin.init(tracer, config)
}
