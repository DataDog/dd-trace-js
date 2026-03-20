'use strict'

const path = require('node:path')

const { DD_MAJOR } = require('../../../version')
const { addHook } = require('./helpers/instrument')

const noopTask = {
  'dd:testSuiteStart': () => null,
  'dd:beforeEach': () => ({}),
  'dd:afterEach': () => null,
  'dd:addTags': () => null,
  'dd:log': () => null,
}

// Resolve base path once, using realpath to avoid macOS /var->/private/var symlink
// module-cache mismatches between ci/init.js and this instrumentation.
const basePath = path.resolve(__dirname, '..', '..', '..')

function wrapSetupNodeEvents (originalSetupNodeEvents) {
  return function ddSetupNodeEvents (on, config) {
    // Call user's setupNodeEvents first so dd-trace hooks register last
    if (originalSetupNodeEvents) {
      const result = originalSetupNodeEvents.call(this, on, config)
      if (result) {
        config = result
      }
    }

    try {
      // Use global._ddtrace to bypass macOS symlink module-cache mismatch.
      // The tracer is initialized by ci/init.js via NODE_OPTIONS before this runs.
      const tracer = global._ddtrace

      if (!tracer || !tracer._initialized) {
        on('task', noopTask)
        return config
      }

      const NoopTracer = require(path.join(basePath, 'packages', 'dd-trace', 'src', 'noop', 'tracer'))

      if (tracer._tracer instanceof NoopTracer) {
        on('task', noopTask)
        return config
      }

      const cypressPlugin = require(path.join(basePath, 'packages', 'datadog-plugin-cypress', 'src', 'cypress-plugin'))

      // If the user already called the manual plugin (dd-trace/ci/cypress/plugin),
      // cypressPlugin._isInit is true. Skip to avoid double registration.
      if (cypressPlugin._isInit) {
        return config
      }

      on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))
      on('after:spec', cypressPlugin.afterSpec.bind(cypressPlugin))
      on('after:run', cypressPlugin.afterRun.bind(cypressPlugin))
      on('task', cypressPlugin.getTasks())

      return cypressPlugin.init(tracer, config)
    } catch {
      // If anything goes wrong, register noop tasks so Cypress can still run
      on('task', noopTask)
      return config
    }
  }
}

function wrapConfig (config) {
  if (config?.e2e) {
    config.e2e.setupNodeEvents = wrapSetupNodeEvents(config.e2e.setupNodeEvents)
  }
}

// Cypress >=10 introduced defineConfig and setupNodeEvents.
// Auto-instrumentation wraps these to inject the plugin automatically.
addHook({
  name: 'cypress',
  versions: ['>=10.2.0'],
}, (cypress) => {
  const originalDefineConfig = cypress.defineConfig
  cypress.defineConfig = function (config) {
    wrapConfig(config)
    return originalDefineConfig(config)
  }

  const originalRun = cypress.run
  cypress.run = function (options) {
    if (options?.config) {
      wrapConfig(options.config)
    }
    return originalRun.apply(this, arguments)
  }

  return cypress
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
