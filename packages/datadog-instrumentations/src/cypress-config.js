'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const { isTrue, isFalse } = require('../../dd-trace/src/util')
const log = require('../../dd-trace/src/log')
const { getEnvironmentVariable, getValueFromEnvSources } = require('../../dd-trace/src/config/helper')

const DD_CONFIG_WRAPPED = Symbol('dd-trace.cypress.config.wrapped')
const DD_CLI_CONFIG_WRAPPER_FILE = 'dd-cypress-config'
const DEFAULT_FLUSH_INTERVAL = 5000
const DD_TRACE_PRELOADS = {
  'dd-trace/register.js': require.resolve('../../../register.js'),
  'dd-trace/ci/init': require.resolve('../../../ci/init'),
  'dd-trace/loader-hook.mjs': require.resolve('../../../loader-hook.mjs'),
}

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
    if (content.includes('dd-trace/ci/cypress/support')) return
  } catch {
    return
  }

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
    // Can't write wrapper - skip injection
  }
}

/**
 * Initializes CI Visibility for the Cypress config/plugin process when Cypress
 * strips NODE_OPTIONS before loading an ESM config file in Electron.
 *
 * This cannot just reuse ci/init directly because ci/init intentionally skips
 * CLI tools and Electron processes, and this fallback exists specifically for
 * Cypress's config/plugin process after NODE_OPTIONS is removed from that path.
 *
 * @returns {object|undefined} tracer singleton
 */
function ensureCiVisibilityTracer () {
  const tracer = global._ddtrace || require('../../../packages/dd-trace')

  if (tracer?._initialized) {
    return tracer
  }

  if (isFalse(getValueFromEnvSources('DD_CIVISIBILITY_ENABLED'))) {
    return tracer
  }

  const isAgentlessEnabled = isTrue(getValueFromEnvSources('DD_CIVISIBILITY_AGENTLESS_ENABLED'))
  const options = {
    startupLogs: false,
    isCiVisibility: true,
    flushInterval: DEFAULT_FLUSH_INTERVAL,
  }

  if (isAgentlessEnabled) {
    if (getValueFromEnvSources('DD_API_KEY')) {
      options.experimental = { exporter: 'datadog' }
    } else {
      log.warn(
        'DD_CIVISIBILITY_AGENTLESS_ENABLED is set, but DD_API_KEY is undefined, so Cypress CI Visibility is disabled.'
      )
      return tracer
    }
  } else {
    options.experimental = { exporter: 'agent_proxy' }
  }

  tracer.init(options)
  tracer.use('fs', false)
  tracer.use('child_process', false)

  return tracer
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

  const tracer = ensureCiVisibilityTracer()

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
 * @param {object|undefined} options
 * @returns {{ options: object|undefined, cleanup: Function }}
 */
function wrapCliConfigFileOptions (options) {
  if (typeof options?.configFile !== 'string' || path.extname(options.configFile) !== '.mjs') {
    return { options, cleanup: () => {} }
  }

  const projectRoot = typeof options.project === 'string' ? options.project : process.cwd()
  const originalConfigFile = path.isAbsolute(options.configFile)
    ? options.configFile
    : path.resolve(projectRoot, options.configFile)
  const wrapConfigFile = require.resolve('../../../ci/cypress/wrap-config')
  const wrapperFile = path.join(
    os.tmpdir(),
    `${DD_CLI_CONFIG_WRAPPER_FILE}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  )

  fs.writeFileSync(wrapperFile, [
    `import originalConfig from ${JSON.stringify(pathToFileURL(originalConfigFile).href)}`,
    `import wrapConfig from ${JSON.stringify(pathToFileURL(wrapConfigFile).href)}`,
    '',
    'export default wrapConfig(originalConfig)',
    '',
  ].join('\n'))

  return {
    options: {
      ...options,
      configFile: wrapperFile,
    },
    cleanup: () => {
      try { fs.unlinkSync(wrapperFile) } catch { /* best effort */ }
    },
  }
}

/**
 * Rewrite dd-trace preloads to absolute paths so Cypress child processes can
 * resolve them even when their cwd is not the project root.
 *
 * @returns {Function}
 */
function rewriteCliNodeOptions () {
  const originalNodeOptions = getEnvironmentVariable('NODE_OPTIONS')

  if (!originalNodeOptions) {
    return () => {}
  }

  const rewrittenNodeOptions = originalNodeOptions
    .split(/\s+/)
    .map(part => DD_TRACE_PRELOADS[part] || part)
    .join(' ')

  if (rewrittenNodeOptions === originalNodeOptions) {
    return () => {}
  }

  // eslint-disable-next-line eslint-rules/eslint-process-env
  process.env.NODE_OPTIONS = rewrittenNodeOptions

  return () => {
    // eslint-disable-next-line eslint-rules/eslint-process-env
    process.env.NODE_OPTIONS = originalNodeOptions
  }
}

module.exports = {
  rewriteCliNodeOptions,
  wrapCliConfigFileOptions,
  wrapConfig,
}
