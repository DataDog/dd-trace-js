'use strict'

const { stripAnsi } = require('./test-output')

const FILESYSTEM_PERMISSION_PATTERN = /\b(?:EACCES|EPERM|Operation not permitted|Permission denied)\b/i
const LOCAL_SOCKET_PATTERN = /\b(?:127\.0\.0\.1|localhost|listen)\b/i
const CONNECTION_REFUSED_PATTERN = /\bECONNREFUSED\b|\bconnection refused\b/i
const NO_TESTS_FOUND_PATTERN =
  /\b(?:No test files? found|No tests? found|No test files? were found|0 tests? collected)\b/i
const MODULE_OR_TRANSFORM_PATTERN =
  /\b(?:Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath\b[\s\S]*\bnot defined by "exports"|Could not resolve|transform failed)\b/i
const CYPRESS_BINARY_PATTERN =
  /(?:Cypress executable not found|Cypress binary is missing|Cypress failed to start|Please reinstall Cypress)/i
const PLAYWRIGHT_BROWSER_PATTERN = new RegExp(
  String.raw`(?:browserType\.launch: Executable doesn't exist|` +
  'Please run the following command to download new browsers|playwright install)',
  'i'
)
const PLAYWRIGHT_BROWSER_LAUNCH_PATTERN =
  /(?:browserType\.launch: Failed to launch the browser process|bootstrap_check_in|MachPortRendezvous)/i
const PLAYWRIGHT_BROWSER_ABORT_PATTERN =
  /(?:browserType\.launch: Target page, context or browser has been closed|Browser logs:)[\s\S]*?(?:signal=SIGABRT|Received signal 6|Abort trap: 6)/i
const VITEST_BROWSER_PROVIDER_PATTERN =
  /(?:Cannot find (?:module|package).*@vitest\/browser|@vitest\/browser-[^\s'"]+.*(?:missing|not (?:found|installed)))/i
const RUNNER_COMMAND_NOT_FOUND_PATTERN =
  /(?:command not found|is not recognized as an internal or external command|spawn [^\r\n]+ ENOENT)/i

/**
 * Identifies toolchain and execution-environment failures that happen before tests start.
 *
 * @param {object} result command result
 * @param {string} [result.stdout] captured stdout
 * @param {string} [result.stderr] captured stderr
 * @param {object} [options] classification options
 * @param {boolean} [options.browserRequired] whether the selected runner uses browser mode
 * @param {string} [options.framework] test framework identifier
 * @param {boolean} [options.testsRan] whether reliable test output was observed
 * @returns {object|undefined} structured blocker diagnosis
 */
function getCommandBlocker (result, options = {}) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (Array.isArray(result.missingRequiredEnvVars) && result.missingRequiredEnvVars.length > 0) {
    return {
      kind: 'project-command-environment-missing',
      summary: 'The selected project test command requires approved non-secret environment variables that are not ' +
        'available in the validator process. No Test Optimization conclusion was reached.',
      recommendation: `Set the required project test variables (${result.missingRequiredEnvVars.join(', ')}) in the ` +
        'environment that launches the validator, then render and approve a fresh plan.',
      signals: result.missingRequiredEnvVars.map(name => `${name} is not set.`),
      toolchainBlocked: true,
    }
  }
  if (LOCAL_SOCKET_PATTERN.test(output) && FILESYSTEM_PERMISSION_PATTERN.test(output)) {
    return {
      kind: 'local-test-socket-blocked',
      summary: 'The selected project test could not start its localhost listener in this execution environment. ' +
        'The offline Datadog validator did not open this socket. No Test Optimization conclusion was reached.',
      recommendation: 'Run the same approved plan in an environment that permits the project test to use its ' +
        'required localhost socket. This may require normal project-test permissions. Do not request broader ' +
        'permissions automatically or interpret this as a Test Optimization failure.',
      signals: getMatchingLines(
        output,
        /127\.0\.0\.1|localhost|listen|EACCES|EPERM|Operation not permitted|Permission denied/i
      ),
      blockedByExecutionEnvironment: true,
    }
  }
  if (options.framework === 'cypress' && result.exitCode !== 0 &&
    CONNECTION_REFUSED_PATTERN.test(output) && LOCAL_SOCKET_PATTERN.test(output)) {
    return {
      kind: 'cypress-application-unavailable',
      summary: 'The selected Cypress spec could not connect to its localhost application. Discovery does not start ' +
        'customer services, so no Test Optimization conclusion was reached.',
      recommendation: 'Start the application through the project\'s normal setup, confirm the selected Cypress spec ' +
        'passes normally, then render and approve a fresh validation plan.',
      signals: getMatchingLines(output, /ECONNREFUSED|connection refused|127\.0\.0\.1|localhost/i),
      blockedByProjectSetup: true,
    }
  }
  if (options.testsRan !== true && NO_TESTS_FOUND_PATTERN.test(output)) {
    return {
      kind: 'no-tests-collected',
      summary: 'The selected representative was not collected by the project test runner. No Test Optimization ' +
        'conclusion was reached.',
      recommendation: 'Use the project\'s normal configuration to make a single runtime test collectible, then ' +
        'create a fresh validation plan. Type-only tests and files outside the runner\'s include rules are not valid ' +
        'representatives.',
      signals: getMatchingLines(output, NO_TESTS_FOUND_PATTERN),
      blockedByProjectSetup: true,
    }
  }

  const browserMode = options.framework === 'playwright' ||
    (options.framework === 'vitest' && options.browserRequired === true)
  if (browserMode &&
    result.exitCode !== 0 &&
    PLAYWRIGHT_BROWSER_LAUNCH_PATTERN.test(output) && FILESYSTEM_PERMISSION_PATTERN.test(output)) {
    const runner = options.framework === 'vitest' ? 'Vitest browser mode' : 'Playwright'
    return {
      kind: `${options.framework}-browser-launch-blocked`,
      summary: `${runner} needs to launch the project browser, but the current agent sandbox denied that launch. ` +
        'No Test Optimization conclusion was reached.',
      recommendation: 'Retry the same approved plan from a host shell or another environment where the installed ' +
        'project browser can launch. Do not request broader permissions automatically or change the command, ' +
        'approval file, or approval SHA.',
      signals: getMatchingLines(
        output,
        /browserType\.launch|bootstrap_check_in|MachPortRendezvous|EACCES|EPERM|Operation not permitted|Permission denied/i
      ),
      blockedByExecutionEnvironment: true,
    }
  }

  if (options.framework === 'playwright' && result.exitCode !== 0 &&
    PLAYWRIGHT_BROWSER_ABORT_PATTERN.test(stripAnsi(output))) {
    return {
      kind: 'playwright-browser-process-aborted',
      summary: 'A browser launched by Playwright aborted before the selected tests could produce reliable results. ' +
        'The available evidence does not identify whether the browser/runtime setup, the project, the execution ' +
        'environment, or another local condition caused the abort. No Test Optimization conclusion was reached.',
      recommendation: 'Run the same approved Playwright command directly in the project\'s normal test environment ' +
        'and collect Playwright, browser, and operating-system crash diagnostics. If it succeeds there, render and ' +
        'approve a fresh validation plan in that environment. Do not treat this result as a Test Optimization failure.',
      signals: getMatchingLines(
        output,
        /browserType\.launch: Target page, context or browser has been closed|signal=SIGABRT|Received signal 6|Abort trap: 6/i
      ),
      localRuntimeBlocked: true,
    }
  }

  if (options.framework === 'cypress' && result.exitCode !== 0 &&
    options.testsRan !== true && CYPRESS_BINARY_PATTERN.test(output)) {
    return {
      kind: 'cypress-runtime-missing',
      summary: 'The Cypress npm package is installed, but its application binary is missing or could not start. ' +
        'No Test Optimization conclusion was reached.',
      recommendation: 'Complete the project\'s normal Cypress binary/browser setup, then render and approve a ' +
        'fresh validation plan. The validator does not download browsers automatically.',
      signals: getMatchingLines(output, CYPRESS_BINARY_PATTERN),
      toolchainBlocked: true,
    }
  }

  if (browserMode && result.exitCode !== 0 && options.testsRan !== true &&
    PLAYWRIGHT_BROWSER_PATTERN.test(output)) {
    const vitestBrowser = options.framework === 'vitest' && options.browserRequired === true
    return {
      kind: vitestBrowser ? 'vitest-browser-provider-missing' : 'playwright-browser-missing',
      summary: `${vitestBrowser ? 'Vitest browser mode' : 'Playwright Test'} is installed, but the selected project ` +
        'test requires a browser binary or provider that is not installed. ' +
        'No Test Optimization conclusion was reached.',
      recommendation: `Complete the project's normal ${vitestBrowser ? 'Vitest browser' : 'Playwright browser'} ` +
        'setup, then render and approve a fresh ' +
        'validation plan. The validator does not download browsers automatically.',
      signals: getMatchingLines(output, PLAYWRIGHT_BROWSER_PATTERN),
      toolchainBlocked: true,
    }
  }

  if (result.exitCode !== 0 && options.testsRan !== true && options.framework === 'vitest' &&
    options.browserRequired === true && VITEST_BROWSER_PROVIDER_PATTERN.test(output)) {
    return {
      kind: 'vitest-browser-provider-missing',
      summary: 'Vitest browser mode could not load its configured browser provider. Local Test Optimization ' +
        'compatibility was not tested. No Test Optimization conclusion was reached.',
      recommendation: 'Complete the project\'s normal Vitest browser setup, then render and approve a fresh ' +
        'validation plan. The validator does not install browser providers or download browsers automatically.',
      signals: getMatchingLines(output, VITEST_BROWSER_PROVIDER_PATTERN),
      toolchainBlocked: true,
    }
  }

  if (result.exitCode !== 0 && options.testsRan !== true && RUNNER_COMMAND_NOT_FOUND_PATTERN.test(output)) {
    return {
      kind: 'test-runner-command-missing',
      summary: 'The selected project test command could not find its test-runner executable, so local Test ' +
        'Optimization compatibility was not tested. No Test Optimization conclusion was reached.',
      recommendation: 'Complete the project\'s normal dependency or package-manager setup so the selected test ' +
        'command can resolve its runner, then render and approve a fresh validation plan.',
      signals: getMatchingLines(output, RUNNER_COMMAND_NOT_FOUND_PATTERN),
      toolchainBlocked: true,
    }
  }

  if (result.exitCode !== 0 && options.testsRan !== true && MODULE_OR_TRANSFORM_PATTERN.test(output)) {
    return {
      kind: 'project-command-initialization-failed',
      summary: 'The selected project test command failed during module resolution, transformation, or runner ' +
        'initialization before a reliable test result was observed. No Test Optimization conclusion was reached.',
      recommendation: 'Satisfy the selected test command\'s build and module prerequisites, or select a focused ' +
        'test command whose prerequisites already exist, then render and approve a fresh plan.',
      signals: getMatchingLines(output, MODULE_OR_TRANSFORM_PATTERN),
      toolchainBlocked: true,
    }
  }

  if (options.framework === 'cypress' && result.exitCode === 134 && options.testsRan !== true) {
    return {
      kind: 'cypress-process-aborted',
      summary: 'Cypress exited with code 134 before any test result was observed. The available evidence does not ' +
        'identify whether Cypress, its browser/runtime setup, the project, or the execution environment caused the ' +
        'abort. No Test Optimization conclusion was reached.',
      recommendation: 'Run the same project Cypress command directly in the project\'s normal test environment and ' +
        'capture Cypress or operating-system crash diagnostics. If that command succeeds there, render and approve ' +
        'a fresh validation plan in that environment. Do not treat this result as a Test Optimization failure.',
      signals: [
        'Cypress exited with code 134 before any test result was observed.',
        'The captured output did not match a known setup or execution-environment failure.',
      ],
      localRuntimeBlocked: true,
    }
  }
}

/**
 * Returns a small de-duplicated set of matching output lines.
 *
 * @param {string} output command output
 * @param {RegExp} pattern interesting-line pattern
 * @returns {string[]} matching lines
 */
function getMatchingLines (output, pattern) {
  const lines = []
  const seen = new Set()
  for (const line of output.split(/\r?\n/)) {
    const value = stripAnsi(line).trim()
    if (!value || seen.has(value) || !pattern.test(value)) continue
    seen.add(value)
    lines.push(value)
    if (lines.length === 6) break
  }
  return lines
}

module.exports = { getCommandBlocker }
