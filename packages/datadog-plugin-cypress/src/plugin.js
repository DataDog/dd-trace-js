'use strict'

const dc = require('dc-polyfill')

const satisfies = require('../../../vendor/dist/semifies')
const { DD_MAJOR } = require('../../../version')

const sessionInitCh = dc.channel('ci:cypress:session:init')
const beforeRunCh = dc.channel('ci:cypress:before-run')
const afterSpecCh = dc.channel('ci:cypress:after-spec')
const afterRunCh = dc.channel('ci:cypress:after-run')
const getTasksCh = dc.channel('ci:cypress:get-tasks')

const noopTask = {
  'dd:testSuiteStart': () => null,
  'dd:beforeEach': () => ({}),
  'dd:afterEach': () => null,
  'dd:addTags': () => null,
  'dd:log': () => null,
}

module.exports = function CypressPlugin (on, config) {
  if (satisfies(config.version, '<10.2.0')) {
    if (DD_MAJOR >= 6) {
      // eslint-disable-next-line no-console
      console.error('ERROR: dd-trace v6 has deleted support for Cypress<10.2.0.')
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

  if (!sessionInitCh.hasSubscribers) {
    on('task', noopTask)
    return config
  }

  const ctx = { config }
  sessionInitCh.publish(ctx)

  on('before:run', (details) => {
    return new Promise(resolve => beforeRunCh.publish({ details, onDone: resolve }))
  })

  on('after:spec', (spec, results) => {
    return new Promise(resolve => afterSpecCh.publish({ spec, results, onDone: resolve }))
  })

  on('after:run', (results) => {
    return new Promise(resolve => afterRunCh.publish({ results, onDone: resolve }))
  })

  const tasksCtx = {}
  getTasksCh.publish(tasksCtx)
  on('task', tasksCtx.tasks ?? noopTask)

  return Promise.resolve(ctx.initPromise).then(() => config)
}
