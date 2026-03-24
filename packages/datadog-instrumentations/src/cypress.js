'use strict'

const fs = require('fs')

const shimmer = require('../../datadog-shimmer')
const { DD_MAJOR } = require('../../../version')
const { addHook } = require('./helpers/instrument')

const noopTask = {
  'dd:testSuiteStart': () => null,
  'dd:beforeEach': () => ({}),
  'dd:afterEach': () => null,
  'dd:addTags': () => null,
  'dd:log': () => null,
}

/**
 * Injects dd-trace's browser-side support code into the Cypress support file.
 * Prepends a `require`/`import` of dd-trace's support to the user's support file
 * so browser-side hooks (beforeEach, afterEach, retries, etc.) are loaded automatically.
 *
 * @param {object} config Cypress resolved config object
 */
function injectSupportFile (config) {
  const originalSupportFile = config.supportFile
  if (!originalSupportFile || originalSupportFile === false) return

  // If the user's support file already loads our support, skip injection.
  try {
    const content = fs.readFileSync(originalSupportFile, 'utf8')
    if (content.includes('dd-trace/ci/cypress/support')) return

    // Use ESM import syntax for .mjs files, CommonJS require for everything else
    const isEsm = originalSupportFile.endsWith('.mjs')
    const ddSupportLine = isEsm
      ? "import 'dd-trace/ci/cypress/support'\n"
      : "require('dd-trace/ci/cypress/support')\n"

    fs.writeFileSync(originalSupportFile, ddSupportLine + content)
  } catch {
    // Can't read/write the file — skip injection to avoid breaking anything
  }
}

function wrapSetupNodeEvents (originalSetupNodeEvents) {
  return function ddSetupNodeEvents (on, config) {
    // Intercept after:spec and after:run registrations from user's setupNodeEvents
    // so we can chain them with dd-trace's handlers rather than overriding them.
    const userAfterSpecHandlers = []
    const userAfterRunHandlers = []

    const wrappedOn = (event, handler) => {
      if (event === 'after:spec') {
        userAfterSpecHandlers.push(handler)
      } else if (event === 'after:run') {
        userAfterRunHandlers.push(handler)
      } else {
        on(event, handler)
      }
    }

    // Call user's setupNodeEvents first so user config mutations are applied.
    // Only replace config if the user returns a valid config object (has projectRoot).
    // This guards against the old manual plugin returning an empty object from cypressPlugin.init().
    if (originalSetupNodeEvents) {
      const result = originalSetupNodeEvents.call(this, wrappedOn, config)
      if (result?.projectRoot) {
        config = result
      }
    }

    try {
      // Always inject the support file, even if the manual plugin was already called.
      injectSupportFile(config)

      // global._ddtrace is the singleton set by dd-trace/index.js. It is always the
      // same object regardless of how dd-trace was required (which path was resolved).
      // On macOS, /var -> /private/var symlinks mean the same physical file can be
      // cached under two different paths, creating multiple module instances. Using
      // the global bypasses module resolution entirely and guarantees we get the one
      // tracer that ci/init.js already initialized via NODE_OPTIONS.
      const tracer = global._ddtrace

      if (!tracer || !tracer._initialized) {
        // Flush user's after:spec/after:run through since we won't be registering ours
        for (const h of userAfterSpecHandlers) on('after:spec', h)
        for (const h of userAfterRunHandlers) on('after:run', h)
        on('task', noopTask)
        return config
      }

      const NoopTracer = require('../../../packages/dd-trace/src/noop/tracer')

      if (tracer._tracer instanceof NoopTracer) {
        for (const h of userAfterSpecHandlers) on('after:spec', h)
        for (const h of userAfterRunHandlers) on('after:run', h)
        on('task', noopTask)
        return config
      }

      const cypressPlugin = require('../../../packages/datadog-plugin-cypress/src/cypress-plugin')

      // If the user already called the manual plugin (dd-trace/ci/cypress/plugin),
      // cypressPlugin._isInit is true. Re-register their intercepted handlers and skip.
      if (cypressPlugin._isInit) {
        for (const h of userAfterSpecHandlers) on('after:spec', h)
        for (const h of userAfterRunHandlers) on('after:run', h)
        return config
      }

      on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))

      // Chain user's after:spec handlers with dd-trace's, awaiting each in sequence
      on('after:spec', (spec, results) => {
        const chain = userAfterSpecHandlers.reduce(
          (p, h) => p.then(() => h(spec, results)),
          Promise.resolve()
        )
        return chain.then(() => cypressPlugin.afterSpec(spec, results))
      })

      // Chain user's after:run handlers with dd-trace's, awaiting each in sequence
      on('after:run', (results) => {
        const chain = userAfterRunHandlers.reduce(
          (p, h) => p.then(() => h(results)),
          Promise.resolve()
        )
        return chain.then(() => cypressPlugin.afterRun(results))
      })

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
  // Also wrap component testing config if present
  if (config?.component) {
    config.component.setupNodeEvents = wrapSetupNodeEvents(config.component.setupNodeEvents)
  }
}

// Cypress >=10 introduced defineConfig and setupNodeEvents.
// Auto-instrumentation wraps these to inject the plugin automatically.
addHook({
  name: 'cypress',
  versions: ['>=10.2.0'],
}, (cypress) => {
  shimmer.wrap(cypress, 'defineConfig', (defineConfig) => function (config) {
    wrapConfig(config)
    return defineConfig(config)
  })

  shimmer.wrap(cypress, 'run', (run) => function (options) {
    if (options?.config) {
      wrapConfig(options.config)
    }
    return run.apply(this, arguments)
  })

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
