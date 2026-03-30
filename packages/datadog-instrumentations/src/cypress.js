'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const shimmer = require('../../datadog-shimmer')
const { DD_MAJOR } = require('../../../version')
const { addHook } = require('./helpers/instrument')

const DD_WRAPPED = Symbol('dd-trace.cypress.wrapped')

const noopTask = {
  'dd:testSuiteStart': () => null,
  'dd:beforeEach': () => ({}),
  'dd:afterEach': () => null,
  'dd:addTags': () => null,
  'dd:log': () => null,
}

/**
 * Creates a temporary wrapper support file under os.tmpdir() that loads
 * dd-trace's browser-side hooks before the user's original support file.
 * Returns the wrapper path (for cleanup) or undefined if injection was skipped.
 *
 * @param {object} config Cypress resolved config object
 * @returns {string|undefined} wrapper file path, or undefined if skipped
 */
function injectSupportFile (config) {
  const originalSupportFile = config.supportFile
  if (!originalSupportFile || originalSupportFile === false) return

  try {
    const content = fs.readFileSync(originalSupportFile, 'utf8')
    if (content.includes('dd-trace/ci/cypress/support')) return
  } catch {
    return
  }

  // Resolve the absolute path to dd-trace's support file so the wrapper works
  // from os.tmpdir() where dd-trace isn't in node_modules.
  const ddSupportFile = require.resolve('../../../ci/cypress/support')

  const ext = path.extname(originalSupportFile)
  const wrapperFile = path.join(os.tmpdir(), `dd-cypress-support-${process.pid}${ext}`)
  const isEsm = ext === '.mjs'

  const wrapperContent = isEsm
    ? `import ${JSON.stringify(ddSupportFile)}\nimport ${JSON.stringify(originalSupportFile)}\n`
    : `require(${JSON.stringify(ddSupportFile)})\nrequire(${JSON.stringify(originalSupportFile)})\n`

  try {
    fs.writeFileSync(wrapperFile, wrapperContent)
    config.supportFile = wrapperFile
    return wrapperFile
  } catch {
    // Can't write wrapper — skip injection
  }
}

/**
 * Core instrumentation logic called from within setupNodeEvents.
 * Registers dd-trace's Cypress hooks (before:run, after:spec, after:run, tasks)
 * and injects the support file. Handles chaining with user-registered handlers
 * for after:spec/after:run so both the user's code and dd-trace's run in sequence.
 *
 * @param {Function} on Cypress event registration function
 * @param {object} config Cypress resolved config object
 * @param {Function[]} userAfterSpecHandlers user's after:spec handlers collected from wrappedOn
 * @param {Function[]} userAfterRunHandlers user's after:run handlers collected from wrappedOn
 * @returns {object} the config object (possibly modified)
 */
function registerDdTraceHooks (on, config, userAfterSpecHandlers, userAfterRunHandlers) {
  const wrapperFile = injectSupportFile(config)

  const cleanupWrapper = () => {
    if (wrapperFile) {
      try { fs.unlinkSync(wrapperFile) } catch { /* best effort */ }
    }
  }

  // global._ddtrace is the singleton set by dd-trace/index.js. It is always the
  // same object regardless of how dd-trace was required (which path was resolved).
  // On macOS, /var -> /private/var symlinks mean the same physical file can be
  // cached under two different paths, creating multiple module instances. Using
  // the global bypasses module resolution entirely and guarantees we get the one
  // tracer that ci/init.js already initialized via NODE_OPTIONS.
  const tracer = global._ddtrace

  const registerAfterRunWithCleanup = () => {
    on('after:run', (results) => {
      const chain = userAfterRunHandlers.reduce(
        (p, h) => p.then(() => h(results)),
        Promise.resolve()
      )
      return chain.finally(cleanupWrapper)
    })
  }

  const registerNoopHandlers = () => {
    for (const h of userAfterSpecHandlers) on('after:spec', h)
    registerAfterRunWithCleanup()
    on('task', noopTask)
  }

  if (!tracer || !tracer._initialized) {
    registerNoopHandlers()
    return config
  }

  const NoopTracer = require('../../../packages/dd-trace/src/noop/tracer')

  if (tracer._tracer instanceof NoopTracer) {
    registerNoopHandlers()
    return config
  }

  const cypressPlugin = require('../../../packages/datadog-plugin-cypress/src/cypress-plugin')

  // If the user already called the manual plugin (dd-trace/ci/cypress/plugin),
  // cypressPlugin._isInit is true. Re-register their intercepted handlers and skip.
  if (cypressPlugin._isInit) {
    for (const h of userAfterSpecHandlers) on('after:spec', h)
    registerAfterRunWithCleanup()
    return config
  }

  on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))

  on('after:spec', (spec, results) => {
    const chain = userAfterSpecHandlers.reduce(
      (p, h) => p.then(() => h(spec, results)),
      Promise.resolve()
    )
    return chain.then(() => cypressPlugin.afterSpec(spec, results))
  })

  on('after:run', (results) => {
    const chain = userAfterRunHandlers.reduce(
      (p, h) => p.then(() => h(results)),
      Promise.resolve()
    )
    return chain
      .then(() => cypressPlugin.afterRun(results))
      .finally(cleanupWrapper)
  })

  on('task', cypressPlugin.getTasks())

  // init() returns a Promise — Cypress awaits it for async config mutations
  // (e.g. library configuration, retries). Resolve with config so Cypress gets it back.
  return Promise.resolve(cypressPlugin.init(tracer, config)).then(() => config)
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

    // The user's setupNodeEvents may be async (return a Promise).
    // We must await it before proceeding so async config mutations land.
    const maybePromise = originalSetupNodeEvents
      ? originalSetupNodeEvents.call(this, wrappedOn, config)
      : undefined

    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.then((result) => {
        if (result?.projectRoot) config = result
        return registerDdTraceHooks(on, config, userAfterSpecHandlers, userAfterRunHandlers)
      })
    }

    if (maybePromise?.projectRoot) config = maybePromise
    return registerDdTraceHooks(on, config, userAfterSpecHandlers, userAfterRunHandlers)
  }
}

function wrapConfig (config) {
  if (!config || config[DD_WRAPPED]) return
  config[DD_WRAPPED] = true

  if (config.e2e) {
    config.e2e.setupNodeEvents = wrapSetupNodeEvents(config.e2e.setupNodeEvents)
  }
  if (config.component) {
    config.component.setupNodeEvents = wrapSetupNodeEvents(config.component.setupNodeEvents)
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

  shimmer.wrap(cypress, 'open', (open) => function (options) {
    if (options?.config) {
      wrapConfig(options.config)
    }
    return open.apply(this, arguments)
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
