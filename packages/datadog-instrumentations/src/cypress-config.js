'use strict'

const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const log = require('../../dd-trace/src/log')
const { channel } = require('./helpers/instrument')

const DD_CONFIG_WRAPPED = Symbol.for('dd-trace.cypress.config.wrapped')
const BROWSER_INSTRUMENTATION_NOT_INSTALLED =
  'Browser-side Cypress Test Optimization instrumentation was not installed.'
const CONFIG_INSTRUMENTATION_NOT_INSTALLED =
  'Cypress configurations that cannot be intercepted through cypress.defineConfig were not auto-instrumented.'
const generatedFilesForExitCleanup = new Set()
let exitCleanupRegistered = false

const setupNodeEventsCh = channel('ci:cypress:setup-node-events')

// Ensure the cypress plugin is loaded so it can subscribe to our channel.
// Normally, plugins are loaded when their npm module is required (via addHook),
// but plain-object configs don't require('cypress'), so the plugin would never
// be instantiated in the Cypress Config Manager child process.
const loadCh = channel('dd-trace:instrumentation:load')
if (loadCh.hasSubscribers) {
  loadCh.publish({ name: 'cypress' })
}

const noopTask = {
  'dd:testSuiteStart': () => null,
  'dd:beforeEach': () => ({}),
  'dd:afterEach': () => null,
  'dd:addTags': () => null,
  'dd:log': () => null,
}

/** @typedef {Error & { code?: string, path?: string, syscall?: string }} FileSystemError */
/** @typedef {{ directory: string, error: FileSystemError }} FileCreationFailure */

/**
 * @param {FileSystemError} error filesystem error
 * @param {string} fallbackPath path used when the error does not include one
 * @returns {string} concise error description
 */
function formatFileSystemError (error, fallbackPath) {
  const code = error?.code || error?.name || 'UNKNOWN'
  const syscall = error?.syscall ? ` during ${error.syscall}` : ''
  return `${code}${syscall} at ${error?.path || fallbackPath}`
}

/**
 * @param {string} artifact artifact that could not be created
 * @param {FileCreationFailure[]} failures failed directory attempts
 * @param {string} consequence effect on Cypress instrumentation
 * @param {boolean} [customerVisible] whether to report the failure without requiring debug logging
 * @returns {void}
 */
function warnFileCreationFailures (artifact, failures, consequence, customerVisible = false) {
  const details = failures.map(({ directory, error }) => formatFileSystemError(error, directory)).join('; ')
  const message = 'Datadog could not create %s. Attempts failed: %s. %s'

  if (customerVisible) {
    // eslint-disable-next-line no-console
    console.error('ERROR: ' + message, artifact, details, consequence)
  } else {
    log.warn(message, artifact, details, consequence)
  }
}

/**
 * Reports a definitive browser-instrumentation failure even when dd-trace debug logging is disabled.
 *
 * @param {string} message printf-style error message
 * @param {...unknown} args message arguments
 * @returns {void}
 */
function logBrowserInstrumentationError (message, ...args) {
  // eslint-disable-next-line no-console
  console.error('ERROR: ' + message, ...args)
}

/**
 * @param {string} filePath generated file to remove
 * @returns {void}
 */
function removeGeneratedFile (filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn(
        'Datadog could not remove generated Cypress file %s: %s.',
        filePath,
        formatFileSystemError(error, filePath)
      )
    }
  }
}

/**
 * Removes project-local support files when Cypress exits without firing
 * after:run, as happens in open mode without experimental run events.
 *
 * @returns {void}
 */
function removeGeneratedFilesAtExit () {
  exitCleanupRegistered = false
  for (const filePath of generatedFilesForExitCleanup) removeGeneratedFile(filePath)
  generatedFilesForExitCleanup.clear()
}

/**
 * @param {string[]} filePaths generated support files
 * @returns {void}
 */
function registerGeneratedFilesForExitCleanup (filePaths) {
  for (const filePath of filePaths) generatedFilesForExitCleanup.add(filePath)
  if (exitCleanupRegistered) return

  exitCleanupRegistered = true
  process.once('exit', removeGeneratedFilesAtExit)
}

/**
 * @param {string[]} filePaths generated support files
 * @returns {void}
 */
function cleanupGeneratedFiles (filePaths) {
  for (const filePath of filePaths) {
    generatedFilesForExitCleanup.delete(filePath)
    removeGeneratedFile(filePath)
  }

  if (generatedFilesForExitCleanup.size === 0 && exitCleanupRegistered) {
    process.removeListener('exit', removeGeneratedFilesAtExit)
    exitCleanupRegistered = false
  }
}

/**
 * Writes a new file without following or overwriting an existing path. If the
 * write fails after creation, removes the partial file before rethrowing.
 *
 * @param {string} filePath generated file path
 * @param {string} content generated file content
 * @returns {void}
 */
function writeExclusiveFile (filePath, content) {
  let descriptor
  let operationError

  try {
    descriptor = fs.openSync(filePath, 'wx')
    fs.writeFileSync(descriptor, content)
  } catch (error) {
    operationError = error
  }

  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor)
    } catch (error) {
      if (!operationError) operationError = error
    }
  }

  if (operationError) {
    if (descriptor !== undefined) removeGeneratedFile(filePath)
    throw operationError
  }
}

/**
 * @param {unknown} handler Cypress task registration
 * @returns {boolean}
 */
function isDatadogTaskRegistration (handler) {
  return !!handler && typeof handler === 'object' &&
    typeof handler['dd:testSuiteStart'] === 'function' &&
    typeof handler['dd:beforeEach'] === 'function' &&
    typeof handler['dd:afterEach'] === 'function' &&
    typeof handler['dd:addTags'] === 'function'
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
 * @param {string} rootPath parent path
 * @param {string} candidatePath path that should be inside rootPath
 * @returns {boolean}
 */
function isPathInside (rootPath, candidatePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..')
}

/**
 * @param {string} fromDirectory directory containing the importing file
 * @param {string} importedFile file to import
 * @returns {string}
 */
function getRelativeImportPath (fromDirectory, importedFile) {
  let relativePath = path.relative(fromDirectory, importedFile).split(path.sep).join('/')
  if (!relativePath.startsWith('./') && !relativePath.startsWith('../')) {
    relativePath = `./${relativePath}`
  }
  return relativePath
}

/**
 * Creates project-local support files that Cypress's E2E and component
 * bundlers can both serve. The browser hook is copied because an action-style
 * NODE_OPTIONS preload can live outside Vite's allowed filesystem roots.
 *
 * @param {string} directory writable directory inside the Cypress project
 * @param {string|false|undefined} originalSupportFile user's support file
 * @param {string} browserHooksSource Datadog browser-side support hooks
 * @returns {string[]} generated files
 */
function createSupportWrapper (directory, originalSupportFile, browserHooksSource) {
  const suffix = `${process.pid}-${randomUUID()}`
  const browserHooksFile = path.join(directory, `dd-cypress-support-hooks-${suffix}.mjs`)
  const wrapperFile = path.join(directory, `dd-cypress-support-${suffix}.mjs`)
  const wrapperImports = [
    `import ${JSON.stringify(getRelativeImportPath(directory, browserHooksFile))}`,
  ]

  if (originalSupportFile) {
    wrapperImports.push(`import ${JSON.stringify(getRelativeImportPath(directory, originalSupportFile))}`)
  }

  const generatedFiles = []
  try {
    writeExclusiveFile(browserHooksFile, browserHooksSource)
    generatedFiles.push(browserHooksFile)
    writeExclusiveFile(wrapperFile, `${wrapperImports.join('\n')}\n`)
    generatedFiles.push(wrapperFile)
  } catch (error) {
    for (const generatedFile of generatedFiles) removeGeneratedFile(generatedFile)
    throw error
  }

  return generatedFiles
}

/**
 * Creates temporary project-local support files that load dd-trace's
 * browser-side hooks before the user's original support file. Returns the
 * generated paths for cleanup, or undefined if injection was skipped.
 *
 * @param {object} config Cypress resolved config object
 * @returns {string[]|undefined} generated file paths, or undefined if skipped
 */
function injectSupportFile (config) {
  const originalSupportFile = config.supportFile

  if (originalSupportFile) {
    try {
      const content = fs.readFileSync(originalSupportFile, 'utf8')
      // Naive check: skip lines starting with // or * to avoid matching commented-out imports.
      const hasActiveDdTraceImport = content.split('\n').some(line => {
        const trimmed = line.trim()
        return trimmed.includes('dd-trace/ci/cypress/support') &&
          !trimmed.startsWith('//') && !trimmed.startsWith('*')
      })
      if (hasActiveDdTraceImport) return
    } catch (error) {
      logBrowserInstrumentationError(
        'Datadog could not read the Cypress support file %s: %s. %s',
        originalSupportFile,
        formatFileSystemError(error, originalSupportFile),
        BROWSER_INSTRUMENTATION_NOT_INSTALLED
      )
      return
    }
  }

  let browserHooksSource
  let browserHooksPath
  try {
    browserHooksPath = require.resolve('../../datadog-plugin-cypress/src/support')
    browserHooksSource = fs.readFileSync(browserHooksPath, 'utf8')
  } catch (error) {
    logBrowserInstrumentationError(
      'Datadog could not read its Cypress browser support hooks: %s. %s',
      formatFileSystemError(error, browserHooksPath || 'dd-trace Cypress browser support hooks'),
      BROWSER_INSTRUMENTATION_NOT_INSTALLED
    )
    return
  }

  const projectRoot = config.projectRoot
  const candidateDirectories = []
  if (originalSupportFile) candidateDirectories.push(path.dirname(originalSupportFile))
  if (projectRoot) candidateDirectories.push(projectRoot)
  const failures = []

  for (const directory of new Set(candidateDirectories)) {
    if (projectRoot && !isPathInside(projectRoot, directory)) continue
    try {
      const generatedFiles = createSupportWrapper(directory, originalSupportFile, browserHooksSource)
      config.supportFile = generatedFiles[1]
      return generatedFiles
    } catch (error) {
      failures.push({ directory, error })
      // Try the next directory inside the project.
    }
  }

  if (failures.length > 0) {
    warnFileCreationFailures(
      'the Cypress support wrapper',
      failures,
      BROWSER_INSTRUMENTATION_NOT_INSTALLED,
      true
    )
  } else {
    logBrowserInstrumentationError(
      'Datadog could not create the Cypress support wrapper because no project directory was available. %s',
      BROWSER_INSTRUMENTATION_NOT_INSTALLED
    )
  }
}

/**
 * Registers screenshot handlers collected from a manual plugin call. User
 * handlers run first so a renamed screenshot path reaches the Datadog handler.
 *
 * @param {Function} on Cypress event registration function
 * @param {Function[]} handlers collected after:screenshot handlers
 * @param {Function|undefined} datadogHandler manual Datadog screenshot handler
 * @returns {void}
 */
function registerManualAfterScreenshotHandlers (on, handlers, datadogHandler) {
  const userHandlers = handlers.filter(handler => handler !== datadogHandler)
  if (userHandlers.length === 0) {
    if (datadogHandler) on('after:screenshot', datadogHandler)
    return
  }

  on('after:screenshot', (details) => {
    const chain = userHandlers.reduce(
      (promise, handler) => promise.then((latestDetails) => Promise.resolve(handler(latestDetails)).then(
        returned => (returned == null ? latestDetails : { ...latestDetails, ...returned })
      )),
      Promise.resolve(details)
    )
    return chain.then((finalDetails) => {
      if (!datadogHandler) return finalDetails
      return Promise.resolve(datadogHandler(finalDetails)).then(() => finalDetails)
    })
  })
}

/**
 * Registers one Cypress after:spec handler that runs every collected handler
 * in registration order. Cypress 10+ otherwise keeps only the last handler.
 *
 * @param {Function} on Cypress event registration function
 * @param {Function[]} handlers collected after:spec handlers
 * @returns {void}
 */
function registerAfterSpecHandlers (on, handlers) {
  if (handlers.length === 0) return

  on('after:spec', (spec, results) => handlers.reduce(
    (chain, handler) => chain.then(() => handler(spec, results)),
    Promise.resolve()
  ))
}

/**
 * Registers dd-trace's Cypress hooks (before:run, after:spec, after:run, tasks)
 * and injects the support file. Communicates with the plugin layer via
 * the `ci:cypress:setup-node-events` diagnostic channel, avoiding direct
 * tracer references in the instrumentation layer.
 *
 * @param {Function} on Cypress event registration function
 * @param {object} config Cypress resolved config object
 * @param {Function[]} userAfterSpecHandlers user's after:spec handlers collected from wrappedOn
 * @param {Function[]} userAfterRunHandlers user's after:run handlers collected from wrappedOn
 * @param {Function[]} userAfterScreenshotHandlers user's after:screenshot handlers collected from wrappedOn
 * @param {object} manualPlugin manual plugin registration state
 * @returns {object} the config object (possibly modified)
 */
function registerDdTraceHooks (
  on,
  config,
  userAfterSpecHandlers,
  userAfterRunHandlers,
  userAfterScreenshotHandlers,
  manualPlugin
) {
  const generatedSupportFiles = injectSupportFile(config)
  if (generatedSupportFiles) registerGeneratedFilesForExitCleanup(generatedSupportFiles)

  const cleanupWrapper = () => {
    if (generatedSupportFiles) cleanupGeneratedFiles(generatedSupportFiles)
  }

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
    registerAfterSpecHandlers(on, userAfterSpecHandlers)
    for (const h of userAfterScreenshotHandlers) on('after:screenshot', h)
    registerAfterRunWithCleanup()
    on('task', noopTask)
  }

  if (manualPlugin.detected) {
    registerAfterSpecHandlers(on, userAfterSpecHandlers)
    registerManualAfterScreenshotHandlers(on, userAfterScreenshotHandlers, manualPlugin.afterScreenshotHandler)
    registerAfterRunWithCleanup()
    return config
  }

  if (!setupNodeEventsCh.hasSubscribers) {
    registerNoopHandlers()
    return config
  }

  // Publish to the plugin layer via diagnostic channel.
  // The subscriber sets `payload.registered = true` and optionally
  // `payload.configPromise` when it handles the event.
  const payload = {
    on,
    config,
    userAfterSpecHandlers,
    userAfterRunHandlers,
    userAfterScreenshotHandlers,
    cleanupWrapper,
    registered: false,
    configPromise: undefined,
  }

  setupNodeEventsCh.publish(payload)

  if (!payload.registered) {
    registerNoopHandlers()
    return config
  }

  return payload.configPromise || config
}

/**
 * @param {Function|undefined} originalSetupNodeEvents
 * @returns {Function}
 */
function wrapSetupNodeEvents (originalSetupNodeEvents) {
  return function ddSetupNodeEvents (on, config) {
    const userAfterSpecHandlers = []
    const userAfterRunHandlers = []
    const userAfterScreenshotHandlers = []
    const manualPlugin = {
      detected: false,
      afterScreenshotHandler: undefined,
    }

    const wrappedOn = (event, handler) => {
      if (event === 'after:spec') {
        userAfterSpecHandlers.push(handler)
      } else if (event === 'after:run') {
        userAfterRunHandlers.push(handler)
      } else if (event === 'after:screenshot') {
        userAfterScreenshotHandlers.push(handler)
      } else {
        if (event === 'task' && isDatadogTaskRegistration(handler)) {
          manualPlugin.detected = true
          manualPlugin.afterScreenshotHandler =
            userAfterScreenshotHandlers[userAfterScreenshotHandlers.length - 1]
        }
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
          userAfterRunHandlers,
          userAfterScreenshotHandlers,
          manualPlugin
        )
      })
    }

    return registerDdTraceHooks(
      on,
      mergeReturnedConfig(config, maybePromise),
      userAfterSpecHandlers,
      userAfterRunHandlers,
      userAfterScreenshotHandlers,
      manualPlugin
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
 * Returns `true` if the nearest package.json walking up from `filePath`
 * sets `"type": "module"`. Used to decide whether ambiguous extensions
 * (`.js`, `.ts`) are loaded as ESM or CJS.
 *
 * @param {string} filePath absolute path to a file under the project
 * @returns {boolean}
 */
function isUnderEsmPackage (filePath) {
  let dir = path.dirname(filePath)
  while (true) {
    const candidate = path.join(dir, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      return pkg && pkg.type === 'module'
    } catch { /* no package.json at this level */ }
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * @param {string} originalConfigFile absolute path to the original config file
 * @param {string} wrapperDirectory directory for the generated wrapper
 * @returns {string} path to the generated wrapper file
 */
function createConfigWrapper (originalConfigFile, wrapperDirectory) {
  // Match the module mode Cypress would use for the user's original config
  // so the generated wrapper body parses and imports it correctly.
  const originalExt = path.extname(originalConfigFile)
  const isEsm = originalExt === '.mjs' || originalExt === '.mts' ||
    (originalExt !== '.cjs' && originalExt !== '.cts' && isUnderEsmPackage(originalConfigFile))

  // Preserve explicit TypeScript extensions. If an ambiguous `.ts` wrapper
  // falls back across package scopes, make its original module mode explicit
  // instead of inheriting the fallback scope.
  let wrapperExt
  if (originalExt === '.ts') {
    const wrapperIsEsm = isUnderEsmPackage(path.join(wrapperDirectory, 'wrapper.ts'))
    wrapperExt = wrapperIsEsm === isEsm ? originalExt : (isEsm ? '.mts' : '.cts')
  } else if (originalExt === '.cts' || originalExt === '.mts') {
    wrapperExt = originalExt
  } else {
    wrapperExt = isEsm ? '.mjs' : '.cjs'
  }

  const wrapperFile = path.join(
    wrapperDirectory,
    `.dd-cypress-config-${process.pid}-${randomUUID()}${wrapperExt}`
  )

  const cypressConfigPath = require.resolve('./cypress-config')

  // ESM body: `import` default-interops a CJS module (cypress-config.js)
  //   by exposing its `module.exports` as the default binding, and handles
  //   both CJS and ESM user configs transparently.
  // CJS body: avoids top-level `import` — older Cypress transpiles `.ts`
  //   configs through CJS ts-node, where `require('file://...')` is not
  //   supported. Guards against ES-module-default shape so TS-authored
  //   configs using `export default` still work.
  const body = isEsm
    ? [
        `import originalConfig from ${JSON.stringify(pathToFileURL(originalConfigFile).href)}`,
        `import cypressConfig from ${JSON.stringify(pathToFileURL(cypressConfigPath).href)}`,
        '',
        'export default cypressConfig.wrapConfig(originalConfig)',
        '',
      ].join('\n')
    : [
        `const cypressConfig = require(${JSON.stringify(cypressConfigPath)})`,
        `const originalExports = require(${JSON.stringify(originalConfigFile)})`,
        'const originalConfig = originalExports && originalExports.__esModule',
        '  ? originalExports.default',
        '  : originalExports',
        'module.exports = cypressConfig.wrapConfig(originalConfig)',
        '',
      ].join('\n')

  writeExclusiveFile(wrapperFile, body)
  return wrapperFile
}

/**
 * @param {string} projectRoot
 * @returns {boolean}
 */
function isTypeScript6OrNewer (projectRoot) {
  try {
    // eslint-disable-next-line n/no-unpublished-require
    const packageJsonPath = require.resolve('typescript/package.json', { paths: [projectRoot] })
    const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    const major = Number(String(version).split('.', 1)[0])
    return major >= 6
  } catch {
    return false
  }
}

/**
 * @param {string} projectRoot
 * @param {string} configFilePath
 * @returns {() => void}
 */
function configureTsNodeForTypeScript6 (projectRoot, configFilePath) {
  const configExt = path.extname(configFilePath)
  if (configExt !== '.ts' && configExt !== '.cts' && configExt !== '.mts') return () => {}
  if (!isTypeScript6OrNewer(projectRoot)) return () => {}

  /* eslint-disable eslint-rules/eslint-process-env */
  const previousCompilerOptions = process.env.TS_NODE_COMPILER_OPTIONS
  let compilerOptions = {}
  if (previousCompilerOptions) {
    try {
      compilerOptions = JSON.parse(previousCompilerOptions)
    } catch {
      compilerOptions = {}
    }
  }

  process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
    ...compilerOptions,
    ignoreDeprecations: '6.0',
  })

  return () => {
    if (previousCompilerOptions === undefined) {
      delete process.env.TS_NODE_COMPILER_OPTIONS
    } else {
      process.env.TS_NODE_COMPILER_OPTIONS = previousCompilerOptions
    }
  }
  /* eslint-enable eslint-rules/eslint-process-env */
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

  if (!configFilePath || !fs.existsSync(configFilePath)) return noop

  let wrapperFile
  const failures = []
  for (const wrapperDirectory of new Set([path.dirname(configFilePath), projectRoot])) {
    try {
      wrapperFile = createConfigWrapper(configFilePath, wrapperDirectory)
      break
    } catch (error) {
      failures.push({ directory: wrapperDirectory, error })
      // Try the project root as the fallback location.
    }
  }

  if (!wrapperFile) {
    warnFileCreationFailures(
      'the Cypress configuration wrapper',
      failures,
      CONFIG_INSTRUMENTATION_NOT_INSTALLED
    )
    return noop
  }

  try {
    const restoreTsNodeCompilerOptions = configureTsNodeForTypeScript6(projectRoot, configFilePath)

    return {
      options: { ...options, configFile: wrapperFile },
      cleanup: () => {
        restoreTsNodeCompilerOptions()
        removeGeneratedFile(wrapperFile)
      },
    }
  } catch {
    removeGeneratedFile(wrapperFile)
    return noop
  }
}

module.exports = {
  wrapCliConfigFileOptions,
  wrapConfig,
}
