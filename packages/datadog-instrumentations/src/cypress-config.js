'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const DD_CONFIG_WRAPPED = Symbol('dd-trace.cypress.config.wrapped')

const noopTask = {
  'dd:testSuiteStart': () => null,
  'dd:beforeEach': () => ({}),
  'dd:afterEach': () => null,
  'dd:addTags': () => null,
  'dd:log': () => null,
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject (value) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Cypress allows setupNodeEvents to return partial config fragments that it
 * diffs and merges into the resolved config. Preserve that behavior here so
 * the wrapper does not drop user-provided config updates.
 *
 * @param {object} config Cypress resolved config object
 * @param {unknown} updatedConfig value returned from setupNodeEvents
 * @returns {object} resolved config with returned overrides applied
 */
function mergeReturnedConfig (config, updatedConfig) {
  if (!isPlainObject(updatedConfig) || updatedConfig === config) {
    return config
  }

  const mergedConfig = { ...config }

  for (const [key, value] of Object.entries(updatedConfig)) {
    mergedConfig[key] = isPlainObject(value) && isPlainObject(mergedConfig[key])
      ? mergeReturnedConfig(mergedConfig[key], value)
      : value
  }

  return mergedConfig
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
    // Naive check: skip lines starting with // or * to avoid matching commented-out imports.
    const hasActiveDdTraceImport = content.split('\n').some(line => {
      const trimmed = line.trim()
      return trimmed.includes('dd-trace/ci/cypress/support') &&
        !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    if (hasActiveDdTraceImport) return
  } catch {
    return
  }

  const ddSupportFile = require.resolve('../../../ci/cypress/support')
  const wrapperFile = path.join(os.tmpdir(), `dd-cypress-support-${process.pid}.mjs`)

  // Always use ESM: it can import both CJS and ESM support files.
  const wrapperContent =
    `import ${JSON.stringify(ddSupportFile)}\nimport ${JSON.stringify(originalSupportFile)}\n`

  try {
    fs.writeFileSync(wrapperFile, wrapperContent)
    config.supportFile = wrapperFile
    return wrapperFile
  } catch {
    // Can't write wrapper - skip injection
  }
}

/**
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

  return Promise.resolve(cypressPlugin.init(tracer, config)).then(() => config)
}

/**
 * @param {Function|undefined} originalSetupNodeEvents
 * @returns {Function}
 */
function wrapSetupNodeEvents (originalSetupNodeEvents) {
  return function ddSetupNodeEvents (on, config) {
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

    const maybePromise = originalSetupNodeEvents
      ? originalSetupNodeEvents.call(this, wrappedOn, config)
      : undefined

    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.then((result) => {
        return registerDdTraceHooks(
          on,
          mergeReturnedConfig(config, result),
          userAfterSpecHandlers,
          userAfterRunHandlers
        )
      })
    }

    return registerDdTraceHooks(
      on,
      mergeReturnedConfig(config, maybePromise),
      userAfterSpecHandlers,
      userAfterRunHandlers
    )
  }
}

/**
 * @param {object} config
 * @returns {object}
 */
function wrapConfig (config) {
  if (!config || config[DD_CONFIG_WRAPPED]) return config
  config[DD_CONFIG_WRAPPED] = true

  if (config.e2e) {
    config.e2e.setupNodeEvents = wrapSetupNodeEvents(config.e2e.setupNodeEvents)
  }
  if (config.component) {
    config.component.setupNodeEvents = wrapSetupNodeEvents(config.component.setupNodeEvents)
  }

  return config
}

/**
 * @param {string} originalConfigFile absolute path to the original config file
 * @returns {string} path to the generated wrapper file
 */
function createConfigWrapper (originalConfigFile) {
  const wrapperFile = path.join(
    path.dirname(originalConfigFile),
    `.dd-cypress-config-${process.pid}.mjs`
  )

  const cypressConfigPath = require.resolve('./cypress-config')

  // Always use ESM: it can import both CJS and ESM configs, so it works
  // regardless of the original file's extension or "type": "module" in package.json.
  // Import cypress-config.js directly (CJS default = module.exports object).
  fs.writeFileSync(wrapperFile, [
    `import originalConfig from ${JSON.stringify(pathToFileURL(originalConfigFile).href)}`,
    `import cypressConfig from ${JSON.stringify(pathToFileURL(cypressConfigPath).href)}`,
    '',
    'export default cypressConfig.wrapConfig(originalConfig)',
    '',
  ].join('\n'))

  return wrapperFile
}

/**
 * Wraps the Cypress config file for a CLI start() call. When an explicit
 * configFile is provided, creates a temp wrapper that imports the original
 * and passes it through wrapConfig. This handles ESM configs (.mjs) and
 * plain-object configs (without defineConfig) that can't be intercepted
 * via the defineConfig shimmer.
 *
 * @param {object|undefined} options
 * @returns {{ options: object|undefined, cleanup: Function }}
 */
function wrapCliConfigFileOptions (options) {
  const noop = { options, cleanup: () => {} }

  if (!options) return noop

  const projectRoot = typeof options.project === 'string' ? options.project : process.cwd()
  let configFilePath

  if (options.configFile === false) {
    // configFile: false means "no config file" — respect Cypress's semantics
    return noop
  } else if (typeof options.configFile === 'string') {
    configFilePath = path.isAbsolute(options.configFile)
      ? options.configFile
      : path.resolve(projectRoot, options.configFile)
  } else {
    // No explicit --config-file: resolve the default cypress.config.{js,ts,cjs,mjs}
    for (const ext of ['.js', '.ts', '.cjs', '.mjs']) {
      const candidate = path.join(projectRoot, `cypress.config${ext}`)
      if (fs.existsSync(candidate)) {
        configFilePath = candidate
        break
      }
    }
  }

  // Skip .ts files — Cypress transpiles them internally via its own loader.
  // The ESM wrapper can't import .ts directly. The defineConfig shimmer
  // handles .ts configs since they're transpiled to CJS by Cypress.
  if (!configFilePath || !fs.existsSync(configFilePath) || path.extname(configFilePath) === '.ts') return noop

  try {
    const wrapperFile = createConfigWrapper(configFilePath)

    return {
      options: { ...options, configFile: wrapperFile },
      cleanup: () => {
        try { fs.unlinkSync(wrapperFile) } catch { /* best effort */ }
      },
    }
  } catch {
    // Config directory may be read-only — fall back to no wrapping.
    // The defineConfig shimmer will still handle configs that use defineConfig.
    return noop
  }
}

module.exports = {
  wrapCliConfigFileOptions,
  wrapConfig,
}
