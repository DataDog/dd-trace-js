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

/**
 * Wraps `start` on an object (or its `.default`) if present.
 *
 * @param {object} mod module exports
 * @returns {object} mod
 */
function wrapStartOnModule (mod) {
  const target = mod.default || mod
  if (typeof target.start === 'function') {
    shimmer.wrap(target, 'start', getCliStartWrapper)
  }
  return mod
}

// Hook the CLI entry points where Cypress resolves and executes `run`/`open`.
// Cypress 10-14: lib/exec/{run,open}.js as separate files.
// Cypress 15-15.10: dist/exec/{run,open}.js as separate files.
// Cypress >=15.11: bundled into dist/cli-<hash>.js exporting runModule/openModule.
for (const file of ['lib/exec/run.js', 'lib/exec/open.js', 'dist/exec/run.js', 'dist/exec/open.js']) {
  addHook({
    name: 'cypress',
    versions: ['>=10.2.0'],
    file,
  }, wrapStartOnModule)
}

// Cypress >=15.11 bundles run/open into a single CLI chunk (dist/cli-<hash>.js).
// The chunk exports runModule and openModule, each with a start() method.
addHook({
  name: 'cypress',
  versions: ['>=10.2.0'],
  filePattern: 'dist/cli.*',
}, (cliChunk) => {
  if (cliChunk.runModule?.start) {
    shimmer.wrap(cliChunk.runModule, 'start', getCliStartWrapper)
  }
  if (cliChunk.openModule?.start) {
    shimmer.wrap(cliChunk.openModule, 'start', getCliStartWrapper)
  }
  return cliChunk
})

// Cypress <10 uses the old pluginsFile approach. No auto-instrumentation;
// users must use the manual dd-trace/ci/cypress/plugin setup.
// This hook is kept so the plugin system registers Cypress for version tracking.
if (DD_MAJOR < 6) {
  addHook({
    name: 'cypress',
    versions: ['>=6.7.0 <10.2.0'],
  }, lib => lib)
}
