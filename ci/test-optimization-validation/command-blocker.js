'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { BLOCKER_CATEGORIES } = require('./blocker-category')
const { isProjectBuildArtifactPath } = require('./project-build-artifact')
const { stripAnsi } = require('./test-output')

const FILESYSTEM_PERMISSION_PATTERN = /\b(?:EACCES|EPERM|Operation not permitted|Permission denied)\b/i
const LOCAL_SOCKET_PATTERN = /\b(?:127\.0\.0\.1|localhost|listen)\b/i
const CONNECTION_REFUSED_PATTERN = /\bECONNREFUSED\b|\bconnection refused\b/i
const NO_TESTS_FOUND_PATTERN =
  /\b(?:No test files? found|No tests? found|No test files? were found|0 tests? collected)\b/i
const MODULE_OR_TRANSFORM_PATTERN =
  /\b(?:Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath\b[\s\S]+\bnot defined by "exports"|Could not resolve|transform failed)\b/i
const BUILD_ARTIFACT_PATH_PATTERN = String.raw`(?:^|[\\/])(?:build|dist|generated)(?:[\\/]|['"])`
const MISSING_ARTIFACT_MESSAGE_PATTERN =
  /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ENOENT|no such file or directory|is not found|does not exist|could not be found/
/* eslint-disable regexp/no-useless-non-capturing-group, regexp/prefer-character-class --
 * The interpolated message fragment contains alternatives and must stay grouped on both sides of the path. */
const BUILD_ARTIFACT_MISSING_PATTERN = new RegExp(
  String.raw`(?:(?:${MISSING_ARTIFACT_MESSAGE_PATTERN.source})[^\r\n]{0,500}${BUILD_ARTIFACT_PATH_PATTERN}|` +
    String.raw`${BUILD_ARTIFACT_PATH_PATTERN}[^\r\n]{0,500}(?:${MISSING_ARTIFACT_MESSAGE_PATTERN.source}))`,
  'im'
)
/* eslint-enable regexp/no-useless-non-capturing-group, regexp/prefer-character-class */
const FILE_PATH_REFERENCE_PATTERN = /(?:^|[\s('"`])((?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])[^'"`\s),;]*)/g
const CUCUMBER_CONFIG_OPTION_UNSUPPORTED_PATTERN = /unknown option ['"]--config['"]/i
const CYPRESS_BINARY_PATTERN =
  /Cypress executable not found|Cypress binary is missing|Cypress failed to start|Please reinstall Cypress/i
const PLAYWRIGHT_BROWSER_PATTERN = new RegExp(
  String.raw`browserType\.launch: Executable doesn't exist|` +
  'Please run the following command to download new browsers|playwright install',
  'i'
)
const PLAYWRIGHT_BROWSER_LAUNCH_PATTERN =
  /Failed to launch the browser process|bootstrap_check_in|MachPortRendezvous/i
const PLAYWRIGHT_BROWSER_ABORT_PATTERN =
  /(?:browserType\.launch: Target page, context or browser has been closed|Browser logs:)[\s\S]*?(?:signal=SIGABRT|Received signal 6|Abort trap: 6)/i
const PUPPETEER_BROWSER_PATTERN =
  /(?:Could not find (?:Chrome|Chromium)|Failed to launch the browser process|Troubleshooting:\s*https:\/\/pptr\.dev)/i
const PUPPETEER_BROWSER_ABORT_PATTERN =
  /Failed to launch the browser process[\s\S]*?(?:signal=SIGABRT|Received signal 6|Abort trap: 6)/i
const CUCUMBER_BROWSER_FAILURE_PATTERN =
  /(?:browser|puppeteer|playwright|webdriver)[^\r\n]{1,160}\b(?:aborted|closed|crashed|failed|terminated|unavailable)\b|(?:Failed|Unable) to (?:connect to|launch|start) (?:the )?browser/i
const VITEST_BROWSER_PROVIDER_PATTERN =
  /Cannot find (?:module|package).*@vitest\/browser|@vitest\/browser-[^\s'"].*(?:missing|not (?:found|installed))/i
const RUNNER_COMMAND_NOT_FOUND_PATTERN =
  /command not found|is not recognized as an internal or external command|spawn [^\r\n]+ ENOENT/i

/**
 * Identifies toolchain and execution-environment failures that happen before tests start.
 *
 * @param {object} result command result
 * @param {string} [result.stdout] captured stdout
 * @param {string} [result.stderr] captured stderr
 * @param {object} [options] classification options
 * @param {boolean} [options.browserRequired] whether the selected runner uses browser mode
 * @param {string} [options.framework] test framework identifier
 * @param {string} [options.packageJson] approval-bound project package.json
 * @param {boolean} [options.testsRan] whether reliable test output was observed
 * @returns {object|undefined} structured blocker diagnosis
 */
function getCommandBlocker (result, options = {}) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (Array.isArray(result.missingRequiredEnvVars) && result.missingRequiredEnvVars.length > 0) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      kind: 'project-command-environment-missing',
      summary: 'The selected project test command requires approved non-secret environment variables that are not ' +
        'available in the validator process. No Test Optimization conclusion was reached.',
      recommendation: `Set the required project test variables (${result.missingRequiredEnvVars.join(', ')}) in the ` +
        'environment that launches the validator, then render and approve a fresh plan.',
      signals: result.missingRequiredEnvVars.map(name => `${name} is not set.`),
      toolchainBlocked: true,
    }
  }
  if (options.framework === 'cucumber' && result.exitCode !== 0 &&
    CUCUMBER_CONFIG_OPTION_UNSUPPORTED_PATTERN.test(output)) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
      kind: 'cucumber-config-isolation-unsupported',
      summary: 'The installed Cucumber CLI rejected the validator-owned configuration-isolation option. This is a ' +
        'validator compatibility limitation, not a project test or Test Optimization failure.',
      recommendation: 'Report this Cucumber version to validator engineering. Use the static CI audit and do not ' +
        'change the customer profile, command, or working directory to bypass this limitation.',
      signals: getMatchingLines(output, CUCUMBER_CONFIG_OPTION_UNSUPPORTED_PATTERN),
      validatorBlocked: true,
    }
  }
  if (LOCAL_SOCKET_PATTERN.test(output) && FILESYSTEM_PERMISSION_PATTERN.test(output)) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.EXECUTION_ENVIRONMENT_BLOCKED,
      kind: 'local-test-socket-blocked',
      summary: 'The selected project test could not start its localhost listener in this execution environment. ' +
        'The offline Datadog validator did not open this socket. No Test Optimization conclusion was reached.',
      recommendation: 'Run the same approved plan in an environment that permits the project test to use its ' +
        'required localhost socket. Use the unchanged command and SHA from execution-plan.md. This may require ' +
        'normal project-test permissions. Do not request broader permissions automatically or interpret this as a ' +
        'Test Optimization failure.',
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
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
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
      blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
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
    (options.framework === 'cucumber' && options.browserRequired === true) ||
    (options.framework === 'vitest' && options.browserRequired === true)
  if (browserMode &&
    result.exitCode !== 0 &&
    PLAYWRIGHT_BROWSER_LAUNCH_PATTERN.test(output) && FILESYSTEM_PERMISSION_PATTERN.test(output)) {
    const runner = getBrowserRunnerName(options.framework)
    return {
      blockerCategory: BLOCKER_CATEGORIES.EXECUTION_ENVIRONMENT_BLOCKED,
      kind: `${options.framework}-browser-launch-blocked`,
      summary: `${runner} needs to launch the project browser, but the current execution environment denied that ` +
        'launch. ' +
        'No Test Optimization conclusion was reached.',
      recommendation: 'Retry the same approved plan from a host shell or another environment where the installed ' +
        'project browser can launch. Use the unchanged command and SHA from execution-plan.md. Do not request ' +
        'broader permissions automatically or change the command, approval file, or approval SHA.',
      signals: getMatchingLines(
        output,
        /Failed to launch the browser process|bootstrap_check_in|MachPortRendezvous|EACCES|EPERM|Operation not permitted|Permission denied/i
      ),
      blockedByExecutionEnvironment: true,
    }
  }

  if (options.framework === 'playwright' && result.exitCode !== 0 &&
    PLAYWRIGHT_BROWSER_ABORT_PATTERN.test(stripAnsi(output))) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.CLEAN_TEST_FAILED,
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

  if (options.framework === 'cucumber' && options.browserRequired === true && result.exitCode !== 0 &&
    PUPPETEER_BROWSER_ABORT_PATTERN.test(stripAnsi(output))) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.CLEAN_TEST_FAILED,
      kind: 'cucumber-browser-process-aborted',
      summary: 'A browser launched by the selected Cucumber support code aborted before a reliable scenario result ' +
        'was observed. No Test Optimization conclusion was reached.',
      recommendation: 'Run the same approved plan where the project\'s normal Cucumber browser tests can launch. ' +
        'Collect the browser and operating-system crash diagnostics if it still fails; do not treat this result as ' +
        'a Test Optimization failure.',
      signals: getMatchingLines(
        output,
        /Failed to launch the browser process|signal=SIGABRT|Received signal 6|Abort trap: 6/i
      ),
      localRuntimeBlocked: true,
    }
  }

  if (options.framework === 'cypress' && result.exitCode !== 0 &&
    options.testsRan !== true && CYPRESS_BINARY_PATTERN.test(output)) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
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
    (PLAYWRIGHT_BROWSER_PATTERN.test(output) || PUPPETEER_BROWSER_PATTERN.test(output))) {
    const vitestBrowser = options.framework === 'vitest' && options.browserRequired === true
    const cucumberBrowser = options.framework === 'cucumber'
    const browserPattern = cucumberBrowser ? PUPPETEER_BROWSER_PATTERN : PLAYWRIGHT_BROWSER_PATTERN
    return {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      kind: vitestBrowser
        ? 'vitest-browser-provider-missing'
        : cucumberBrowser
          ? 'cucumber-browser-missing'
          : 'playwright-browser-missing',
      summary: `${getBrowserRunnerName(options.framework)} is installed, but the selected project ` +
        'test requires a browser binary or provider that is not installed. ' +
        'No Test Optimization conclusion was reached.',
      recommendation: `Complete the project's normal ${getBrowserRunnerName(options.framework)} setup, then render ` +
        'and approve a fresh ' +
        'validation plan. The validator does not download browsers automatically.',
      signals: getMatchingLines(output, browserPattern),
      toolchainBlocked: true,
    }
  }

  if (result.exitCode !== 0 && options.testsRan !== true && options.framework === 'vitest' &&
    options.browserRequired === true && VITEST_BROWSER_PROVIDER_PATTERN.test(output)) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
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
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      kind: 'test-runner-command-missing',
      summary: 'The selected project test command could not find its test-runner executable, so local Test ' +
        'Optimization compatibility was not tested. No Test Optimization conclusion was reached.',
      recommendation: 'Complete the project\'s normal dependency or package-manager setup so the selected test ' +
        'command can resolve its runner, then render and approve a fresh validation plan.',
      signals: getMatchingLines(output, RUNNER_COMMAND_NOT_FOUND_PATTERN),
      toolchainBlocked: true,
    }
  }

  const projectRoot = typeof options.packageJson === 'string' ? path.dirname(options.packageJson) : undefined
  if (result.exitCode !== 0 && hasMissingProjectBuildArtifact(output, projectRoot)) {
    const buildScript = getBuildScript(options.packageJson)
    return {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      kind: 'project-build-artifact-missing',
      summary: 'The selected test requires a conventional build or generated output that is missing. The validator ' +
        'does not run project build commands, so no Test Optimization conclusion was reached.',
      recommendation: `Complete the project's normal build workflow${
        buildScript ? `; package.json declares "build": ${JSON.stringify(buildScript)}` : ''
      }. Confirm the selected test passes normally, then render and approve a fresh validation plan.`,
      signals: getMatchingLines(output, BUILD_ARTIFACT_MISSING_PATTERN),
      blockedByProjectSetup: true,
    }
  }

  if (result.exitCode !== 0 && options.testsRan !== true && MODULE_OR_TRANSFORM_PATTERN.test(output)) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
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
      blockerCategory: BLOCKER_CATEGORIES.CLEAN_TEST_FAILED,
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

  if (options.framework === 'cucumber' && options.browserRequired === true &&
    result.exitCode !== 0 && options.testsRan !== true &&
    CUCUMBER_BROWSER_FAILURE_PATTERN.test(output)) {
    return {
      blockerCategory: BLOCKER_CATEGORIES.CLEAN_TEST_FAILED,
      kind: 'cucumber-browser-execution-incomplete',
      summary: 'The selected Cucumber scenario uses browser-backed support code and exited before a reliable ' +
        'scenario result was observed. A secondary Cucumber formatter exception is not enough to identify the root ' +
        'cause. No Test Optimization conclusion was reached.',
      recommendation: 'Run the same approved plan where the project\'s normal Cucumber browser tests can launch, ' +
        'then create a fresh plan. If it still fails, preserve the earliest browser or project error rather than ' +
        'treating a later formatter exception as the cause.',
      signals: getMatchingLines(
        output,
        /Failed to launch|Received signal|TypeError|Cannot read|browser|puppeteer|playwright/i
      ),
      localRuntimeBlocked: true,
    }
  }
}

function hasMissingProjectBuildArtifact (output, projectRoot) {
  for (const line of output.split(/\r?\n/)) {
    if (!BUILD_ARTIFACT_MISSING_PATTERN.test(line)) continue
    for (const match of line.matchAll(FILE_PATH_REFERENCE_PATTERN)) {
      if (isProjectBuildArtifactPath(match[1], projectRoot)) return true
    }
  }
  return false
}

function getBuildScript (packageJson) {
  if (typeof packageJson !== 'string') return
  try {
    const stat = fs.statSync(packageJson)
    if (!stat.isFile() || stat.size > 512 * 1024) return
    const script = JSON.parse(fs.readFileSync(packageJson, 'utf8'))?.scripts?.build
    if (typeof script !== 'string' || !script.trim() || Buffer.byteLength(script) > 500 ||
      /[\0\r\n]/.test(script)) return
    return script.trim()
  } catch {}
}

function getBrowserRunnerName (framework) {
  if (framework === 'cucumber') return 'Cucumber browser support'
  if (framework === 'vitest') return 'Vitest browser mode'
  return 'Playwright Test'
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
