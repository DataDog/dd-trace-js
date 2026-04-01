'use strict'

const shimmer = require('../../datadog-shimmer')
const { DD_MAJOR } = require('../../../version')
const { addHook } = require('./helpers/instrument')
const {
  rewriteCliNodeOptions,
  wrapCliConfigFileOptions,
  wrapConfig,
} = require('./cypress-config')

const DD_API_WRAPPED = Symbol('dd-trace.cypress.api.wrapped')

/**
 * Patch a Cypress API object once. ESM loads can expose both a namespace object
 * and a separate default export object, so both shapes need wrapping.
 *
 * @param {object} cypress Cypress API export object
 */
function wrapCypressApi (cypress) {
  if (!cypress || cypress[DD_API_WRAPPED]) return
  cypress[DD_API_WRAPPED] = true

  if (typeof cypress.defineConfig === 'function') {
    shimmer.wrap(cypress, 'defineConfig', (defineConfig) => function (config) {
      wrapConfig(config)
      return defineConfig(config)
    })
  }

  if (typeof cypress.run === 'function') {
    shimmer.wrap(cypress, 'run', (run) => function (options) {
      if (options?.config) {
        wrapConfig(options.config)
      }
      return run.apply(this, arguments)
    })
  }

  if (typeof cypress.open === 'function') {
    shimmer.wrap(cypress, 'open', (open) => function (options) {
      if (options?.config) {
        wrapConfig(options.config)
      }
      return open.apply(this, arguments)
    })
  }
}

// Cypress >=10 introduced defineConfig and setupNodeEvents.
// Auto-instrumentation wraps defineConfig() and cypress.run() to inject the
// plugin automatically. Configs using plain module.exports = { ... } (without
// defineConfig) need to either add defineConfig() or use the manual plugin.
addHook({
  name: 'cypress',
  versions: ['>=10.2.0'],
}, (cypress) => {
  wrapCypressApi(cypress)
  if (cypress?.default && cypress.default !== cypress) {
    wrapCypressApi(cypress.default)
  }

  return cypress
})

function getCliStartWrapper (start) {
  return function ddTraceCliStart (options) {
    const restoreNodeOptions = rewriteCliNodeOptions()
    const { options: wrappedOptions, cleanup } = wrapCliConfigFileOptions(options)
    const result = start.call(this, wrappedOptions)

    if (result && typeof result.then === 'function') {
      return result.finally(() => {
        cleanup()
        restoreNodeOptions()
      })
    }

    cleanup()
    restoreNodeOptions()
    return result
  }
}

for (const file of ['lib/exec/run.js', 'lib/exec/open.js']) {
  addHook({
    name: 'cypress',
    versions: ['>=10.2.0'],
    file,
  }, (cypressExecModule) => {
    shimmer.wrap(cypressExecModule, 'start', getCliStartWrapper)
    return cypressExecModule
  })
}

// Cypress <10 uses the old pluginsFile approach. No auto-instrumentation;
// users must use the manual dd-trace/ci/cypress/plugin setup.
// This hook is kept so the plugin system registers Cypress for version tracking.
if (DD_MAJOR < 6) {
  addHook({
    name: 'cypress',
    versions: ['>=6.7.0 <10.2.0'],
  }, lib => lib)
}
