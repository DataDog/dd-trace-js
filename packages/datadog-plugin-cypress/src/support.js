'use strict'

// No optional chaining or nullish coalescing in this file: Cypress 12 bundles it with webpack 4,
// whose parser predates both, and its babel-loader skips node_modules.

const annotationsKey = Symbol.for('dd-trace:test-annotations')
const emptyAnnotations = { mustFail: false, noAutoRetry: false }
let frameworkRetries = 0
let hasSuiteConfig = false
let isTextTerminal = false
let hasBrowserRetries = false
let browserRetries
let hasGlobalBrowserRetries = false
let globalBrowserRetries
const initialBrowserRetries = Cypress._.cloneDeep(Cypress.config('retries'))
let originalRetries
let configuredRetries
let browserRetrySelection
let globalBrowserRetrySelection
const browserRetryObjects = new WeakMap()
const browserRetryTargets = new WeakMap()
const browserConfigStates = new WeakMap()
const unwrapBrowserRetries = value => browserRetryTargets.get(value) || value
const cypressConfig = Cypress.config

// Getter values are mutable native objects. Track the written path, rather than
// mistaking untouched injected fields for developer configuration.
function overlayBrowserRetries (native, configured, actual) {
  if (Cypress._.isEqual(configured, actual)) return Cypress._.cloneDeep(native)
  if (!actual || typeof actual !== 'object' || !configured || typeof configured !== 'object') {
    return Cypress._.cloneDeep(actual)
  }
  const result = native && typeof native === 'object' ? Cypress._.cloneDeep(native) : {}
  for (const key of Object.keys(actual)) {
    if (!Cypress._.isEqual(configured[key], actual[key])) {
      result[key] = overlayBrowserRetries(result[key], configured[key], actual[key])
    }
  }
  for (const key of Object.keys(configured)) {
    // Cypress 6 predates Object.hasOwn.
    // eslint-disable-next-line prefer-object-has-own
    if (!Object.prototype.hasOwnProperty.call(actual, key)) delete result[key]
  }
  return result
}

function initializeBrowserRetryMetadata (metadata) {
  if (!hasSuiteConfig) return
  if (!metadata.nativeReady) {
    metadata.native = overlayBrowserRetries(originalRetries, configuredRetries, metadata.initial)
    metadata.nativeReady = true
  }
  const writes = metadata.writes.splice(0)
  for (const write of writes) recordBrowserRetryPath(metadata, write.path, write.value, write.deleted)
}

function recordBrowserRetryPath (metadata, path, value, deleted) {
  if (!hasSuiteConfig) {
    metadata.writes.push({ path, value: Cypress._.cloneDeep(value), deleted })
    return
  }
  initializeBrowserRetryMetadata(metadata)
  let native = metadata.native
  if (!native || typeof native !== 'object') native = metadata.native = {}
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (!native[key] || typeof native[key] !== 'object') native[key] = {}
    native = native[key]
  }
  // Cypress 6 uses an older browser without Array.prototype.at.
  // eslint-disable-next-line unicorn/prefer-at
  const key = path[path.length - 1]
  if (deleted) delete native[key]
  else native[key] = Cypress._.cloneDeep(value)
  if (metadata.raw === unwrapBrowserRetries(cypressConfig.call(Cypress, 'retries'))) {
    browserRetries = metadata.native
    browserRetrySelection = metadata
    hasBrowserRetries = true
    const test = Cypress.state('test')
    const config = test && test._testConfig
    const overrides = config && (config.unverifiedTestConfig || config)
    if (!overrides || overrides.retries === undefined) {
      globalBrowserRetries = metadata.native
      globalBrowserRetrySelection = metadata
      hasGlobalBrowserRetries = true
    }
  }
}

function ownsNestedPath (root, path, target) {
  let current = root
  for (const key of path) {
    if (!current || typeof current !== 'object') return false
    current = unwrapBrowserRetries(current[key])
  }
  return current === target
}

function observeBrowserRetries (raw) {
  raw = unwrapBrowserRetries(raw)
  if (!raw || typeof raw !== 'object') return raw
  if (browserRetryObjects.has(raw)) return browserRetryObjects.get(raw).proxy
  const metadata = {
    raw,
    initial: Cypress._.cloneDeep(raw),
    native: Cypress._.cloneDeep(hasBrowserRetries ? browserRetries : originalRetries),
    nativeReady: hasSuiteConfig || hasBrowserRetries,
    writes: [],
  }
  const proxies = new WeakMap()
  function wrap (value, path) {
    if (!value || typeof value !== 'object') return value
    if (proxies.has(value)) return proxies.get(value)
    const proxy = new Proxy(value, {
      get (target, key, receiver) {
        const result = Reflect.get(target, key, receiver)
        const property = Object.getOwnPropertyDescriptor(target, key)
        return property && !property.configurable && !property.writable && 'value' in property
          ? result
          : wrap(result, [...path, key])
      },
      set (target, key, value) {
        const result = Reflect.set(target, key, unwrapBrowserRetries(value))
        if (result && ownsNestedPath(metadata.raw, path, target)) {
          recordBrowserRetryPath(metadata, [...path, key], value, false)
        }
        return result
      },
      deleteProperty (target, key) {
        const result = Reflect.deleteProperty(target, key)
        if (result && ownsNestedPath(metadata.raw, path, target)) {
          recordBrowserRetryPath(metadata, [...path, key], undefined, true)
        }
        return result
      },
    })
    proxies.set(value, proxy)
    browserRetryTargets.set(proxy, value)
    return proxy
  }
  metadata.proxy = wrap(raw, [])
  browserRetryObjects.set(raw, metadata)
  browserRetryObjects.set(metadata.proxy, metadata)
  return metadata.proxy
}

// New root values are explicit native configuration. Reusing the same observed
// object preserves its field provenance, including through Cypress restoration.
function recordBrowserRetryReplacement (retries, previous) {
  retries = unwrapBrowserRetries(retries)
  const test = Cypress.state('test')
  const applied = test && test._testConfig && test._testConfig.applied
  if (applied === 'restoring') {
    browserRetries = globalBrowserRetries
    browserRetrySelection = globalBrowserRetrySelection
    hasBrowserRetries = hasGlobalBrowserRetries
  } else if (!applied || applied === 'complete' || Cypress.state('duringUserTestExecution')) {
    if (retries && typeof retries === 'object' && retries === unwrapBrowserRetries(previous)) return
    const metadata = retries && typeof retries === 'object' && browserRetryObjects.get(retries)
    if (metadata) initializeBrowserRetryMetadata(metadata)
    browserRetrySelection = metadata || undefined
    browserRetries = metadata ? metadata.native : retries
    hasBrowserRetries = true
    const config = test && test._testConfig
    const overrides = config && (config.unverifiedTestConfig || config)
    if (!overrides || overrides.retries === undefined) {
      globalBrowserRetries = browserRetries
      globalBrowserRetrySelection = browserRetrySelection
      hasGlobalBrowserRetries = true
    }
  }
}

function observeBrowserConfig (state) {
  if (browserConfigStates.has(state)) return browserConfigStates.get(state)
  const proxy = new Proxy(state, {
    get (target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      return key === 'retries' ? observeBrowserRetries(value) : value
    },
    set (target, key, value) {
      const previous = target[key]
      const result = Reflect.set(target, key, key === 'retries' ? unwrapBrowserRetries(value) : value)
      if (result && key === 'retries') recordBrowserRetryReplacement(value, previous)
      return result
    },
    deleteProperty (target, key) {
      const previous = target[key]
      const result = Reflect.deleteProperty(target, key)
      if (result && key === 'retries') recordBrowserRetryReplacement(undefined, previous)
      return result
    },
  })
  browserConfigStates.set(state, proxy)
  return proxy
}

Cypress.config = Object.assign(function (key, value) {
  const retries = typeof key === 'object' && key !== null
    ? key.retries
    : key === 'retries' && arguments.length > 1 ? value : undefined
  const previous = retries === undefined ? undefined : cypressConfig.call(this, 'retries')
  const args = [...arguments]
  if (retries !== undefined && unwrapBrowserRetries(retries) !== retries) {
    if (key !== null && typeof key === 'object') args[0] = { ...key, retries: unwrapBrowserRetries(retries) }
    else args[1] = unwrapBrowserRetries(retries)
  }
  const result = cypressConfig.apply(this, args)
  if (retries !== undefined) recordBrowserRetryReplacement(retries, previous)
  if (arguments.length === 0) return observeBrowserConfig(result)
  return key === 'retries' && arguments.length === 1 ? observeBrowserRetries(result) : result
}, cypressConfig)

/** @param {number|object|undefined} configured */
function nativeRetryCount (configured) {
  if (typeof configured === 'number' || configured == null) return configured
  const retries = configured[isTextTerminal ? 'runMode' : 'openMode']
  return retries === true
    ? configured.experimentalOptions && configured.experimentalOptions.maxRetries
    : retries === false ? 0 : retries
}

/** @param {object} test */
function getTestAnnotations (test) {
  return test._ddTestAnnotations || (test.fn && test.fn[annotationsKey]) || emptyAnnotations
}

/** @returns {object[]} Declaration metadata, including tests whose setup never executes. */
function getTestDeclarations () {
  const testAnnotations = []
  Cypress.mocha.getRootSuite().eachTest(test => {
    const annotations = getTestAnnotations(test)
    testAnnotations.push({
      testId: test.id, testName: test.fullTitle(), mustFail: annotations.mustFail, noAutoRetry: annotations.noAutoRetry,
    })
  })
  return testAnnotations
}

let pendingSuiteDeclarationDepth = 0
const testDeclarationProxies = new WeakMap()

function captureTestDeclaration (target, receiver, args) {
  // Cypress 6 uses a browser without Array.prototype.at.
  // eslint-disable-next-line unicorn/prefer-at
  const callback = args[args.length - 1]
  const test = Reflect.apply(target, receiver, args)
  if (test && typeof callback === 'function' && callback[annotationsKey]) {
    const { mustFail, noAutoRetry } = callback[annotationsKey]
    test._ddTestAnnotations = { mustFail, noAutoRetry }
  }
  return test
}

/**
 * @param {Function} declaration
 * @param {boolean} [alwaysCapture]
 */
function wrapTestDeclaration (declaration, alwaysCapture = false) {
  if (testDeclarationProxies.has(declaration)) {
    const existing = testDeclarationProxies.get(declaration)
    if (alwaysCapture) existing.alwaysCapture = true
    return existing.proxy
  }
  const state = { alwaysCapture }
  state.proxy = new Proxy(declaration, {
    // Outside pending declarations, the intrinsic handler contributes no JavaScript
    // wrapper frame to Cypress's native callsite stack. Aliases retain this same proxy.
    get apply () {
      return state.alwaysCapture || pendingSuiteDeclarationDepth > 0 ? captureTestDeclaration : Reflect.apply
    },
    get (target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      const property = Object.getOwnPropertyDescriptor(target, key)
      if (property && !property.configurable && !property.writable && 'value' in property) return value
      return (key === 'skip' || key === 'only') && typeof value === 'function'
        ? wrapTestDeclaration(value, key === 'skip' || state.alwaysCapture)
        : value
    },
  })
  testDeclarationProxies.set(declaration, state)
  return state.proxy
}

// Observe every executable declaration identity, including aliases captured before
// entering a pending suite, while preserving native callsites during normal execution.
for (const name of ['it', 'specify', 'xit', 'xspecify']) {
  const declaration = globalThis[name]
  if (typeof declaration === 'function') {
    globalThis[name] = wrapTestDeclaration(declaration, name === 'xit' || name === 'xspecify')
  }
}

/** @param {Function} declaration */
function wrapSkippedSuiteDeclaration (declaration) {
  return function () {
    pendingSuiteDeclarationDepth++
    try {
      return declaration.apply(this, arguments)
    } finally {
      pendingSuiteDeclarationDepth--
    }
  }
}

for (const name of ['describe', 'context', 'xdescribe', 'xcontext']) {
  const declareSuite = globalThis[name]
  if (typeof declareSuite !== 'function') continue
  if (name === 'xdescribe' || name === 'xcontext') {
    globalThis[name] = wrapSkippedSuiteDeclaration(declareSuite)
  } else if (typeof declareSuite.skip === 'function') {
    declareSuite.skip = wrapSkippedSuiteDeclaration(declareSuite.skip)
  }
}

// If the test is using multi domain with cy.origin, trying to access
// window properties will result in a cross origin error.
function safeGetRum (window) {
  try {
    return window.DD_RUM
  } catch {
    return null
  }
}

/** @param {string} message */
function warnMissingBeforeEachTaskResult (message) {
  // eslint-disable-next-line no-console
  console.warn(message)
}

function disableFrameworkRetries (test) {
  test._retries = 0
}

/** @param {object} test */
function getNativeRetryBudget (test) {
  let retries = hasBrowserRetries
    ? nativeRetryCount(browserRetrySelection ? browserRetrySelection.native : browserRetries)
    : frameworkRetries
  for (let current = test; current; current = current.parent) {
    const config = current._testConfig
    const overrides = config && (config.unverifiedTestConfig || config)
    if (overrides && overrides.retries !== undefined) {
      retries = nativeRetryCount(overrides.retries)
      break
    }
  }
  return Number.isSafeInteger(retries) ? retries : 0
}

function getRetriedTests (test, numRetries, tags) {
  const retriedTests = []
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    const clonedTest = test.clone()
    disableFrameworkRetries(clonedTest)
    if (tags.includes('_ddIsEfdRetry')) {
      clonedTest._ddEfdRetryIndex = retryIndex + 1
    }
    for (const tag of tags) {
      if (tag) {
        clonedTest[tag] = true
      }
    }
    retriedTests.push(clonedTest)
  }
  return retriedTests
}

// Observation must precede user support, while manual lifecycle hooks retain the
// registration point chosen by the public support entry.
let lifecycleHooksInstalled = false
function installLifecycleHooks () {
  if (lifecycleHooksInstalled) return
  lifecycleHooksInstalled = true
  let rumFlushWaitMillis = 500
  let rumTestExecutionIdCookieName

  let isEarlyFlakeDetectionEnabled = false
  let isKnownTestsEnabled = false
  let knownTestsForSuite = []
  let earlyFlakeDetectionSchedulingRetryCount = 0
  let isTestManagementEnabled = false
  let testManagementAttemptToFixRetries = 0
  let testManagementTests = {}
  let isImpactedTestsEnabled = false
  let isModifiedTest = false
  let isTestIsolationEnabled = false
  let isDynamicAtrEnabled = false
  let hasWarnedMissingBeforeEachTaskResult = false
  let hasWarnedMissingBeforeEachRetryResult = false
  // Array of test names that have been retried and the reason
  const retryReasonsByTestName = new Map()
  // Dynamic ATR computes the selected budget after the first attempt. Keep that result
  // in browser state and apply it when Cypress starts the retry runnable.
  const dynamicAtrRetryCountByTest = new Map()
  // Track test errors suppressed by test management so we can still report them to Datadog.
  const suppressedTestFailures = new Map()

  // Track the most recently loaded window in the AUT. Updated via the 'window:load'
  // event so we always get the real app window (after cy.visit()), not the
  // about:blank window that exists when beforeEach runs. If the test later navigates
  // to a cross-origin URL, safeGetRum() handles the access error.
  let originalWindow

  let currentTestCommands = []
  const commandStartTimes = new Map()
  const INTERNAL_CYPRESS_COMMANDS = new Set(['wrap', 'then', 'noop'])

  Cypress.on('command:start', (command) => {
    commandStartTimes.set(command.get('id'), { startTime: Date.now(), name: command.get('name') })
  })

  Cypress.on('command:end', (command) => {
    const id = command.get('id')
    const entry = commandStartTimes.get(id)
    commandStartTimes.delete(id)

    const name = command.get('name')
    const args = command.get('args')
    if (name === 'task' && args && typeof args[0] === 'string' && args[0].startsWith('dd:')) {
      return
    }
    if (INTERNAL_CYPRESS_COMMANDS.has(name) || entry == null) {
      return
    }
    const err = command.get('err')
    currentTestCommands.push({
      name,
      startTime: entry.startTime,
      endTime: Date.now(),
      // Serialize the error to a plain object so it survives cy.task JSON transport.
      error: err ? { message: err.message, stack: err.stack, name: err.name } : null,
    })
  })

  function isNewTest (test) {
    // If for whatever reason the worker does not receive valid known tests, we don't consider it as new
    if (!Array.isArray(knownTestsForSuite)) {
      return false
    }
    return !knownTestsForSuite.includes(test.fullTitle())
  }

  function getTestProperties (testName) {
    // TODO: Use optional chaining when we drop support for older Cypress versions, which will happen when dd-trace@5 is
    // EoL. Until then, this files needs to support Node.js 16.
    const properties = testManagementTests[testName] && testManagementTests[testName].properties || {}

    const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } = properties

    return { isAttemptToFix, isDisabled, isQuarantined }
  }

  /**
   * @param {object} test
   * @returns {Cypress.Chainable<{ traceId?: string, shouldSkip?: boolean, shouldDiscard?: boolean }>}
   */
  function runBeforeEachTask (test) {
    return cy.task('dd:beforeEach', test).then((taskResult) => {
      if (taskResult !== undefined && taskResult !== null) {
        return taskResult
      }

      if (!hasWarnedMissingBeforeEachTaskResult) {
        hasWarnedMissingBeforeEachTaskResult = true
        warnMissingBeforeEachTaskResult('Datadog Cypress dd:beforeEach task returned no result. Retrying once.')
      }

      return cy.task('dd:beforeEach', test).then((retryTaskResult) => {
        if (retryTaskResult !== undefined && retryTaskResult !== null) {
          return retryTaskResult
        }

        if (!hasWarnedMissingBeforeEachRetryResult) {
          hasWarnedMissingBeforeEachRetryResult = true
          warnMissingBeforeEachTaskResult(
            'Datadog Cypress dd:beforeEach task returned no result after retry. Continuing with an empty task result.'
          )
        }

        return {}
      })
    })
  }

  /**
   * @param {string} message
   * @param {unknown} error
   * @returns {false}
   */
  function logRumCorrelationCookieError (message, error) {
    try {
      Cypress.log({
        name: 'dd-trace',
        message,
        consoleProps: () => ({ Error: error }),
      })
    } catch (loggingError) {
      // eslint-disable-next-line no-console
      console.error(message, error, loggingError)
    }
    return false
  }

  /**
   * @param {unknown} error
   * @returns {false}
   */
  function handleRumCorrelationCookieError (error) {
    return logRumCorrelationCookieError('Could not set the RUM correlation cookie', error)
  }

  /**
   * @param {unknown} error
   * @returns {false}
   */
  function handleRumCorrelationCookieCleanupError (error) {
    return logRumCorrelationCookieError('Could not clear the previous RUM correlation cookie', error)
  }

  /**
   * @param {string} traceId
   * @returns {Promise<boolean>}
   */
  function setRumCorrelationCookie (traceId) {
    if (typeof cy.now !== 'function') {
      return Cypress.Promise.resolve(handleRumCorrelationCookieError(new Error('Cypress cy.now is not available')))
    }

    let clearCookiePromise = Cypress.Promise.resolve()
    if (!isTestIsolationEnabled) {
      clearCookiePromise = Cypress.Promise.try(() => {
        return cy.now('clearCookie', rumTestExecutionIdCookieName, { log: false })
      }).then(undefined, handleRumCorrelationCookieCleanupError)
    }

    return clearCookiePromise.then(() => {
      return Cypress.Promise.try(() => {
        return cy.now('setCookie', rumTestExecutionIdCookieName, traceId, { log: false })
      })
    }).then(() => true, handleRumCorrelationCookieError)
  }

  /**
   * @param {boolean} isCookieSet
   */
  function restartRumSession (isCookieSet) {
    if (!isCookieSet || isTestIsolationEnabled || !originalWindow) {
      return
    }

    const rum = safeGetRum(originalWindow)
    if (rum) {
      try {
        const evt = new originalWindow.MouseEvent('click', { bubbles: true, cancelable: true })
        // The browser-sdk addEventListener wrapper filters out untrusted synthetic events
        // unless __ddIsTrusted is set. Set it so the click triggers expandOrRenewSession().
        // See: https://github.com/DataDog/browser-sdk/blob/v6.27.1/packages/core/src/browser/addEventListener.ts#L119
        Object.defineProperty(evt, '__ddIsTrusted', { value: true })
        originalWindow.dispatchEvent(evt)
      } catch {}
      if (rum.startView) {
        rum.startView()
      }
    }
  }

  // Catch test failures for quarantined tests and suppress them
  // By not re-throwing the error, Cypress marks the test as passed
  // This allows quarantined tests to run but not affect the exit code
  Cypress.on('fail', (err, runnable) => {
    // For commands that time out, command:end may never fire.
    // Finalize any in-flight commands so their step spans carry the error.
    const hadInFlightCommands = commandStartTimes.size > 0
    for (const [, { startTime, name }] of commandStartTimes) {
      if (INTERNAL_CYPRESS_COMMANDS.has(name)) continue
      currentTestCommands.push({
        name,
        startTime,
        endTime: Date.now(),
        error: { message: err.message, stack: err.stack, name: err.name },
      })
    }
    commandStartTimes.clear()

    // If command:end fired for all commands (none in-flight) but the last command
    // has no error, it means command:end fired before the error was attached to it.
    if (!hadInFlightCommands && currentTestCommands.length > 0) {
      // We have to support very old cypress versions in v5
      // eslint-disable-next-line unicorn/prefer-at
      const lastCommand = currentTestCommands[currentTestCommands.length - 1]
      if (!lastCommand.error) {
        lastCommand.error = { message: err.message, stack: err.stack, name: err.name }
      }
    }

    if (!isTestManagementEnabled) {
      throw err
    }

    const testName = runnable.fullTitle()
    const annotations = getTestAnnotations(runnable)
    const properties = getTestProperties(testName)
    const isAttemptToFix = properties.isAttemptToFix && !annotations.noAutoRetry
    const isQuarantined = properties.isQuarantined && !annotations.mustFail
    const isDisabled = properties.isDisabled && !annotations.mustFail

    // Suppress failures for quarantined or disabled tests so they don't affect the exit code.
    // Attempt-to-fix ignores quarantine/disabled suppression and keeps the normal framework result.
    if (!isAttemptToFix && (isQuarantined || isDisabled)) {
      suppressedTestFailures.set(testName, { error: err, isQuarantined, isDisabled })
      return
    }

    throw err
  })

  function shouldDisableFrameworkRetries (test) {
    return test && (
      test._ddIsAttemptToFix ||
      (isTestIsolationEnabled &&
        isEarlyFlakeDetectionEnabled &&
        (test._ddIsNew || test._ddIsModified))
    )
  }

  const oldRunTests = Cypress.mocha.getRunner().runTests
  Cypress.mocha.getRunner().runTests = function (suite, fn) {
    if (!isKnownTestsEnabled && !isTestManagementEnabled && !isImpactedTestsEnabled) {
      return oldRunTests.apply(this, arguments)
    }
    // We copy the tests array and add retries to it, then assign it back to suite.tests
    // to avoid modifying the array while iterating over it
    const testsWithRetries = []

    for (let testIndex = 0; testIndex < suite.tests.length; testIndex++) {
      const test = suite.tests[testIndex]
      const testName = test.fullTitle()
      const { isAttemptToFix } = getTestProperties(testName)
      const isSkipped = test.isPending()

      const annotations = getTestAnnotations(test)
      const isAtemptToFix = isTestManagementEnabled && isAttemptToFix && !isSkipped && !annotations.noAutoRetry
      const isModified = isImpactedTestsEnabled && isModifiedTest
      const isNew = isKnownTestsEnabled && !isSkipped && isNewTest(test)

      // We want is_modified and is_new regardless of the retry reason
      if (isModified) {
        test._ddIsModified = true
      }
      if (isNew) {
        test._ddIsNew = true
      }

      // Add the original test first
      testsWithRetries.push(test)

      if (!isTestIsolationEnabled || annotations.noAutoRetry) {
        continue
      }

      // Then add retries right after it
      let retriedTests = []
      let retryMessage = ''
      if (isAtemptToFix) {
        test._ddIsAttemptToFix = true
        disableFrameworkRetries(test)
        retryMessage = 'because it is an attempt to fix'
        retriedTests = getRetriedTests(test, testManagementAttemptToFixRetries, ['_ddIsAttemptToFix'])
      } else if (isModified && isEarlyFlakeDetectionEnabled) {
        disableFrameworkRetries(test)
        retryMessage = 'to detect flakes because it is modified'
        retriedTests = getRetriedTests(test, earlyFlakeDetectionSchedulingRetryCount, [
          '_ddIsModified',
          '_ddIsEfdRetry',
          isKnownTestsEnabled && isNewTest(test) && '_ddIsNew',
        ])
      } else if (isNew && isEarlyFlakeDetectionEnabled) {
        disableFrameworkRetries(test)
        retryMessage = 'to detect flakes because it is new'
        retriedTests = getRetriedTests(test, earlyFlakeDetectionSchedulingRetryCount, ['_ddIsNew', '_ddIsEfdRetry'])
      }

      testsWithRetries.push(...retriedTests)

      if (retryMessage) {
        retryReasonsByTestName.set(testName, retryMessage)
      }
    }

    suite.tests = testsWithRetries

    return oldRunTests.apply(this, [suite, fn])
  }

  /**
   * @param {{ id: string }} test
   */
  function getDynamicAtrTestKey (test) {
    // Cypress preserves the runnable ID when cloning a retry, including across browser reloads.
    return `${Cypress.mocha.getRootSuite().file}\0${test.id}`
  }

  /**
   * @param {{ id: string, _retries: number }} test
   */
  function configureTestRetries (test) {
    if (hasSuiteConfig && getTestAnnotations(test).noAutoRetry) {
      // Restore developer configuration after the plugin's global ATR configuration.
      // Read the nearest test/suite override before or after Cypress resolves it.
      test._retries = getNativeRetryBudget(test)
      // Cypress resolves local retries after this event; the support hook reapplies this value.
      return
    }
    if (shouldDisableFrameworkRetries(test)) {
      disableFrameworkRetries(test)
      return
    }

    if (!isTextTerminal) return

    const dynamicAtrRetryCount = dynamicAtrRetryCountByTest.get(getDynamicAtrTestKey(test))
    if (Number.isSafeInteger(dynamicAtrRetryCount)) {
      test._retries = dynamicAtrRetryCount
    } else if (isDynamicAtrEnabled) {
      // Cypress forbids calling retries(count) on the original runnable.
      // Ensure local retries: 0 overrides still reach the duration-based budget selection.
      test._retries = Math.max(1, test._retries)
    }
  }

  Cypress.on('test:before:run', (attributes, test) => {
    configureTestRetries(test)
  })

  Cypress.on('test:before:run:async', (attributes, test) => {
    configureTestRetries(test)
  })

  beforeEach(function () {
    const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
    // The first test:before:run event can precede the suite configuration task.
    configureTestRetries(currentTest)
    const testName = currentTest.fullTitle()

    const retryMessage = retryReasonsByTestName.get(testName)
    if (retryMessage) {
      cy.task(
        'dd:log',
        `Retrying "${testName}" ${retryMessage}`
      )
      retryReasonsByTestName.delete(testName)
    }

    currentTestCommands = []
    commandStartTimes.clear()

    cy.on('window:load', (win) => {
      originalWindow = win
    })

    runBeforeEachTask({
      testId: currentTest.id,
      testName,
      annotations: getTestAnnotations(currentTest),
      testSuite: Cypress.mocha.getRootSuite().file,
      isEfdRetry: Cypress.mocha.getRunner().suite.ctx.currentTest._ddIsEfdRetry,
      efdRetryIndex: Cypress.mocha.getRunner().suite.ctx.currentTest._ddEfdRetryIndex,
    }).then(({ traceId, shouldSkip, shouldDiscard }) => {
      if (shouldDiscard) {
        this.currentTest._ddShouldDiscard = true
      }
      let rumCookiePromise
      if (traceId) {
        rumCookiePromise = setRumCorrelationCookie(traceId)
      }
      if (shouldSkip) {
        // Test Optimization requested this runtime skip through the Cypress support hook.
        this.skip()
      }
      if (rumCookiePromise) {
        return rumCookiePromise.then(restartRumSession)
      }
    }).then(() => {
      // Clear any commands accumulated during DD-owned setup (e.g. setCookie, RUM restart)
      // so they are not reported as user test steps.
      currentTestCommands = []
      commandStartTimes.clear()
    })
  })

  before(function () {
    cy.task('dd:testSuiteStart', {
      testAnnotations: getTestDeclarations(),
      testSuite: Cypress.mocha.getRootSuite().file,
      testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
      isTextTerminal: Cypress.config('isTextTerminal'),
    }).then((suiteConfig) => {
      if (suiteConfig) {
        hasSuiteConfig = true
        frameworkRetries = suiteConfig.frameworkRetries
        originalRetries = suiteConfig.originalRetries
        configuredRetries = suiteConfig.configuredRetries
        const rawRetries = cypressConfig.call(Cypress, 'retries')
        const metadata = rawRetries && typeof rawRetries === 'object' && browserRetryObjects.get(rawRetries)
        if (metadata) initializeBrowserRetryMetadata(metadata)
        if (!hasBrowserRetries &&
            !Cypress._.isEqual(initialBrowserRetries, suiteConfig.configuredRetries)) {
          // Manual support can load after a browser configuration override already happened.
          browserRetries = globalBrowserRetries = overlayBrowserRetries(
            originalRetries, suiteConfig.configuredRetries, initialBrowserRetries
          )
          hasBrowserRetries = hasGlobalBrowserRetries = true
        }
        isEarlyFlakeDetectionEnabled = suiteConfig.isEarlyFlakeDetectionEnabled
        isKnownTestsEnabled = suiteConfig.isKnownTestsEnabled
        knownTestsForSuite = suiteConfig.knownTestsForSuite
        earlyFlakeDetectionSchedulingRetryCount = suiteConfig.earlyFlakeDetectionSchedulingRetryCount
        isTestManagementEnabled = suiteConfig.isTestManagementEnabled
        testManagementAttemptToFixRetries = suiteConfig.testManagementAttemptToFixRetries
        testManagementTests = suiteConfig.testManagementTests
        isImpactedTestsEnabled = suiteConfig.isImpactedTestsEnabled
        isModifiedTest = suiteConfig.isModifiedTest
        isTestIsolationEnabled = suiteConfig.isTestIsolationEnabled
        isDynamicAtrEnabled = suiteConfig.isDynamicAtrEnabled
        isTextTerminal = suiteConfig.isTextTerminal
        if (isTextTerminal) {
          // The first test event can precede this task, and an earlier user hook can skip our beforeEach.
          Cypress.mocha.getRootSuite().eachTest(configureTestRetries)
        }
        rumTestExecutionIdCookieName = suiteConfig.rumTestExecutionIdCookieName
        if (Number.isFinite(suiteConfig.rumFlushWaitMillis)) {
          rumFlushWaitMillis = suiteConfig.rumFlushWaitMillis
        }
      }
    })
  })

  after(() => {
    // Root teardown still runs when a user root setup hook fails before Datadog setup.
    // Publish all declarations so Node-side recovery can annotate the skipped tests.
    if (!hasSuiteConfig) {
      cy.task('dd:testDeclarations', {
        testSuite: Cypress.mocha.getRootSuite().file,
        testAnnotations: getTestDeclarations(),
      })
    }
    dynamicAtrRetryCountByTest.clear()
    try {
      if (safeGetRum(originalWindow)) {
        originalWindow.dispatchEvent(new Event('beforeunload'))
      }
    } catch {
      // ignore error. It's usually a multi origin issue.
    }
  })

  afterEach(function () {
    const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
    if (currentTest._ddShouldDiscard) {
      return
    }
    const testName = currentTest.fullTitle()

    // Check if this was a test management test that we suppressed the failure for.
    const suppressedTestFailure = suppressedTestFailures.get(testName)
    const suppressedError = suppressedTestFailure && suppressedTestFailure.error
    const isTestManagementTestThatFailed = !!suppressedError

    // For suppressed test management tests, convert Error to a serializable format for cy.task.
    const errorToReport = isTestManagementTestThatFailed
      ? { message: suppressedError.message, stack: suppressedError.stack }
      : currentTest.err

    const activeRetries = Cypress.config('retries')
    const nativeRetryFloor = activeRetries && activeRetries.experimentalStrategy ? getNativeRetryBudget(currentTest) : 0
    const testInfo = {
      nativeRetryFloor,
      testId: currentTest.id,
      testName,
      testItTitle: currentTest.title,
      testSuite: Cypress.mocha.getRootSuite().file,
      testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
      // Report the actual failed state to Datadog, not the pass state Cypress sees after suppression.
      state: isTestManagementTestThatFailed ? 'failed' : currentTest.state,
      // Include the actual error that was suppressed.
      error: errorToReport,
      isNew: currentTest._ddIsNew,
      isEfdRetry: currentTest._ddIsEfdRetry,
      isAttemptToFix: currentTest._ddIsAttemptToFix,
      annotations: getTestAnnotations(currentTest),
      isModified: currentTest._ddIsModified,
      hasNativeRetries: !!(currentTest._testConfig && currentTest._testConfig.unverifiedTestConfig &&
        currentTest._testConfig.unverifiedTestConfig.retries !== undefined),
      duration: currentTest.duration,
      // Mark suppressed tests so the plugin can tag them with the correct test management reason.
      isQuarantined: isTestManagementTestThatFailed && suppressedTestFailure.isQuarantined,
      isDisabled: isTestManagementTestThatFailed && suppressedTestFailure.isDisabled,
    }
    try {
      const invocationDetails = Cypress.mocha.getRunner().currentRunnable.invocationDetails
      testInfo.testSourceLine = invocationDetails.line
      testInfo.testSourceStack = invocationDetails.stack
    } catch {}

    // Snapshot before any DD-owned Cypress commands so they are not reported as test steps.
    const commandsToReport = [...currentTestCommands]

    const rum = safeGetRum(originalWindow)
    if (rum) {
      testInfo.isRUMActive = true
      if (rum.stopSession) {
        rum.stopSession()
        // eslint-disable-next-line cypress/no-unnecessary-waiting
        cy.wait(rumFlushWaitMillis)
      }
    }
    let coverage
    try {
      coverage = originalWindow.__coverage__
    } catch {
      // ignore error and continue
    }

    // Clean up the suppressed error tracking.
    if (isTestManagementTestThatFailed) {
      suppressedTestFailures.delete(testName)
    }

    cy.task('dd:afterEach', { test: testInfo, coverage, commands: commandsToReport }).then((taskResult) => {
      // Preserve the first-attempt result until Cypress starts the retry runnable.
      // Changing the completed test here is too late for Cypress's retry lifecycle.
      if (taskResult && Number.isSafeInteger(taskResult.dynamicAtrRetryCount)) {
        dynamicAtrRetryCountByTest.set(getDynamicAtrTestKey(currentTest), taskResult.dynamicAtrRetryCount)
      }
    })
  })
}

const supportRoot = Cypress.mocha.getRootSuite()
supportRoot[Symbol.for('dd-trace.cypress.install-lifecycle')] = installLifecycleHooks
if (!supportRoot[Symbol.for('dd-trace.cypress.defer-lifecycle')]) installLifecycleHooks()
