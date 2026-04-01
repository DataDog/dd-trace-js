'use strict'

const shimmer = require('../../datadog-shimmer')
const { DD_MAJOR } = require('../../../version')
const { addHook } = require('./helpers/instrument')
const {
  wrapCliConfigFileOptions,
  wrapConfig,
} = require('./cypress-config')

// Wrap defineConfig() so configs are instrumented when loaded in Cypress's
// config child process. This covers both CLI and programmatic usage with CJS configs.
addHook({
  name: 'cypress',
  versions: ['>=10.2.0'],
}, (cypress) => {
  if (typeof cypress.defineConfig === 'function') {
    shimmer.wrap(cypress, 'defineConfig', (defineConfig) => function (config) {
      wrapConfig(config)
      return defineConfig(config)
    })
  }
  return cypress
})

// Wrap the CLI entry points (cypress run / cypress open) to handle config files
// that can't be intercepted via the defineConfig shimmer: ESM configs (.mjs)
// and plain-object configs (without defineConfig).
function getCliStartWrapper (start) {
  return function ddTraceCliStart (options) {
    const { options: wrappedOptions, cleanup } = wrapCliConfigFileOptions(options)
    const result = start.call(this, wrappedOptions)

    if (result && typeof result.then === 'function') {
      return result.finally(cleanup)
    }

    cleanup()
    return result
  }
}

for (const file of ['dist/exec/run.js', 'dist/exec/open.js']) {
  addHook({
    name: 'cypress',
    versions: ['>=10.2.0'],
    file,
  }, (cypressExecModule) => {
    const target = cypressExecModule.default || cypressExecModule
    if (typeof target.start === 'function') {
      shimmer.wrap(target, 'start', getCliStartWrapper)
    }
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
