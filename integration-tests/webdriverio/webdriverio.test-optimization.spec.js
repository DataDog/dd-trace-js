'use strict'

const assert = require('node:assert/strict')
const { exec, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const {
  getCiVisAgentlessConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  DI_DEBUG_ERROR_PREFIX,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FINAL_STATUS,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_STATUS,
  TEST_SUITE,
} = require('../../packages/dd-trace/src/plugins/util/test')

const OLDEST_WEBDRIVERIO_VERSION = '9.0.0'
const requestedVersion = process.env.WEBDRIVERIO_VERSION
const versions = requestedVersion
  ? [requestedVersion === 'oldest' ? OLDEST_WEBDRIVERIO_VERSION : requestedVersion]
  : [OLDEST_WEBDRIVERIO_VERSION, 'latest']

const SETTINGS_PATH = '/api/v2/libraries/tests/services/setting'
const KNOWN_TESTS_PATH = '/api/v2/ci/libraries/tests'
const SKIPPABLE_TESTS_PATH = '/api/v2/ci/tests/skippable'
const TEST_MANAGEMENT_PATH = '/api/v2/test/libraries/test-management/tests'

/**
 * Starts the minimal W3C WebDriver endpoint required by WebdriverIO workers.
 *
 * @returns {Promise<{port: number, server: import('node:http').Server, getSessionCount: () => number}>}
 */
function startWebDriverServer () {
  let sessionCount = 0
  const server = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      const isNewSession = request.method === 'POST' && request.url === '/session'
      let value = null

      if (isNewSession) {
        sessionCount++
        value = {
          sessionId: `webdriverio-${sessionCount}`,
          capabilities: {
            browserName: 'chrome',
            browserVersion: 'test',
            platformName: process.platform,
          },
        }
      } else if (request.method === 'GET' && request.url === '/status') {
        value = { ready: true, message: '' }
      }

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ value }))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()

      if (!address || typeof address === 'string') {
        reject(new Error('WebDriver server did not bind to a TCP port'))
        return
      }

      resolve({
        port: address.port,
        server,
        getSessionCount: () => sessionCount,
      })
    })
  })
}

/**
 * Stops an HTTP server if it is listening.
 *
 * @param {import('node:http').Server|undefined} server
 * @returns {Promise<void>}
 */
function stopServer (server) {
  if (!server?.listening) {
    return Promise.resolve()
  }
  return new Promise(resolve => server.close(resolve))
}

/**
 * Gets all test events from intake payloads.
 *
 * @param {object[]} payloads
 * @returns {object[]}
 */
function getEvents (payloads) {
  return payloads
    .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
    .flatMap(({ payload }) => payload.events)
}

/**
 * Counts intake requests for one endpoint.
 *
 * @param {object[]} payloads
 * @param {string} requestPath
 * @returns {number}
 */
function countRequests (payloads, requestPath) {
  return payloads.filter(({ url }) => url.endsWith(requestPath)).length
}

for (const version of versions) {
  describe(`webdriverio@${version} Test Optimization`, function () {
    this.timeout(90_000)

    let childProcess
    let cwd
    let receiver
    let testOutput = ''
    let webDriver

    useSandbox([
      `@wdio/cli@${version}`,
      `@wdio/local-runner@${version}`,
      `@wdio/mocha-framework@${version}`,
    ], true, [
      './integration-tests/webdriverio/fixtures/*',
      './integration-tests/ci-visibility/dynamic-instrumentation/dependency.js',
    ])

    before(async function () {
      cwd = sandboxCwd()
      webDriver = await startWebDriverServer()

      execFileSync('git', ['switch', '-c', 'feature-branch'], { cwd })
      fs.appendFileSync(path.join(cwd, 'impacted.e2e.js'), '\n// modified by the integration test\n')
      execFileSync('git', ['add', 'impacted.e2e.js'], { cwd })
      execFileSync('git', ['commit', '-m', 'modify impacted test'], { cwd })
    })

    after(async function () {
      await stopServer(webDriver?.server)
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async function () {
      childProcess?.kill()
      testOutput = ''
      await receiver.stop()
    })

    /**
     * Runs one WebdriverIO Test Optimization scenario.
     *
     * @param {string} scenario
     * @param {number} expectedWebDriverSessions
     * @param {(payloads: object[]) => void} assertPayloads
     * @param {object} [extraEnvironment]
     * @param {number} [expectedExitCode]
     * @returns {Promise<void>}
     */
    async function runScenario (
      scenario,
      expectedWebDriverSessions,
      assertPayloads,
      extraEnvironment = {},
      expectedExitCode = 0
    ) {
      const initialWebDriverSessionCount = webDriver.getSessionCount()
      childProcess = exec('./node_modules/.bin/wdio run ./wdio.conf.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
          DD_TEST_SESSION_NAME: 'webdriverio-test-optimization',
          GITHUB_BASE_REF: '',
          WEBDRIVERIO_SCENARIO: scenario,
          WEBDRIVER_PORT: String(webDriver.port),
          ...extraEnvironment,
        },
      })
      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
      })

      const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        undefined,
        assertPayloads,
        { hardTimeout: 60_000 }
      )

      let exitCode
      try {
        [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          payloadsPromise,
        ])
      } catch (error) {
        error.message += `\n${testOutput}`
        throw error
      }

      assert.strictEqual(exitCode, expectedExitCode, testOutput)
      assert.doesNotMatch(testOutput, /WebdriverIO Test Optimization .* error/)
      assert.strictEqual(
        webDriver.getSessionCount() - initialWebDriverSessionCount,
        expectedWebDriverSessions
      )
    }

    it('requests enabled data once and keeps TIA disabled across parallel workers', async () => {
      receiver.setSettings({
        code_coverage: true,
        coverage_report_upload_enabled: true,
        impacted_tests_enabled: true,
        itr_enabled: true,
        known_tests_enabled: true,
        test_management: { enabled: true },
        tests_skipping: true,
      })
      receiver.setKnownTests({ webdriverio: {} })
      receiver.setTestManagementTests({ webdriverio: { suites: {} } })

      await runScenario('parallel', 2, payloads => {
        assert.strictEqual(countRequests(payloads, SETTINGS_PATH), 1)
        assert.strictEqual(countRequests(payloads, KNOWN_TESTS_PATH), 1)
        assert.strictEqual(countRequests(payloads, TEST_MANAGEMENT_PATH), 1)
        assert.strictEqual(countRequests(payloads, SKIPPABLE_TESTS_PATH), 0)
        assert.strictEqual(countRequests(payloads, '/api/v2/citestcov'), 0)

        const events = getEvents(payloads)
        const session = events.find(event => event.type === 'test_session_end').content
        const tests = events.filter(event => event.type === 'test')

        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assert.strictEqual(session.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(session.meta[TEST_MANAGEMENT_ENABLED], 'true')
      })
    })

    it('retries new tests with EFD', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          faulty_session_threshold: 100,
          slow_test_retries: { '5s': 2 },
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({ webdriverio: {} })

      await runScenario('efd', 1, payloads => {
        const events = getEvents(payloads)
        const session = events.find(event => event.type === 'test_session_end').content
        const suite = events.find(event => event.type === 'test_suite_end').content
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(countRequests(payloads, KNOWN_TESTS_PATH), 1)
        assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
        assert.strictEqual(tests.length, 3)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['fail', 'pass', 'fail'])
        assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
        for (const test of tests) {
          assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
        }
        for (const test of tests.slice(1)) {
          assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
        }
      })
    })

    it('stops EFD when the run exceeds the faulty-session threshold', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          faulty_session_threshold: 0,
          slow_test_retries: { '5s': 2 },
        },
        known_tests_enabled: true,
      })
      receiver.setKnownTests({ webdriverio: {} })

      await runScenario('efd', 1, payloads => {
        const events = getEvents(payloads)
        const session = events.find(event => event.type === 'test_session_end').content
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], undefined)
        assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta[TEST_IS_NEW], undefined)
        assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
      }, {}, 1)
    })

    it('retries failures with ATR', async () => {
      receiver.setSettings({
        flaky_test_retries_count: 2,
        flaky_test_retries_enabled: true,
      })

      await runScenario('atr', 1, payloads => {
        const tests = getEvents(payloads)
          .filter(event => event.type === 'test')
          .map(event => event.content)

        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        const retry = tests.find(test => test.meta[TEST_IS_RETRY] === 'true')
        assert.ok(retry)
        assert.strictEqual(retry.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
      })
    })

    it('applies disabled, quarantined, and attempt-to-fix policies', async () => {
      receiver.setSettings({
        test_management: {
          attempt_to_fix_retries: 2,
          enabled: true,
        },
      })
      receiver.setTestManagementTests({
        webdriverio: {
          suites: {
            'test-management.e2e.js': {
              tests: {
                'WebdriverIO Test Management is attempt to fix': {
                  properties: { attempt_to_fix: true },
                },
                'WebdriverIO Test Management is disabled': {
                  properties: { disabled: true },
                },
                'WebdriverIO Test Management is quarantined': {
                  properties: { quarantined: true },
                },
              },
            },
          },
        },
      })

      await runScenario('testManagement', 1, payloads => {
        const events = getEvents(payloads)
        const session = events.find(event => event.type === 'test_session_end').content
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        const disabled = tests.find(test => test.meta[TEST_NAME].endsWith('is disabled'))
        const quarantined = tests.find(test => test.meta[TEST_NAME].endsWith('is quarantined'))
        const attemptToFix = tests.filter(test => test.meta[TEST_NAME].endsWith('is attempt to fix'))

        assert.strictEqual(countRequests(payloads, TEST_MANAGEMENT_PATH), 1)
        assert.strictEqual(session.meta[TEST_MANAGEMENT_ENABLED], 'true')
        assert.strictEqual(disabled.meta[TEST_STATUS], 'skip')
        assert.strictEqual(disabled.meta[TEST_FINAL_STATUS], 'skip')
        assert.strictEqual(disabled.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
        assert.strictEqual(quarantined.meta[TEST_STATUS], 'fail')
        assert.strictEqual(quarantined.meta[TEST_FINAL_STATUS], 'skip')
        assert.strictEqual(quarantined.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
        assert.strictEqual(attemptToFix.length, 3)
        for (const test of attemptToFix) {
          assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
        }
        const finalAttempt = attemptToFix.find(test => TEST_FINAL_STATUS in test.meta)
        assert.ok(finalAttempt)
        assert.strictEqual(finalAttempt.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
      })
    })

    it('marks tests from modified files as impacted', async () => {
      receiver.setSettings({ impacted_tests_enabled: true })

      await runScenario('impacted', 1, payloads => {
        const tests = getEvents(payloads)
          .filter(event => event.type === 'test')
          .map(event => event.content)

        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta[TEST_SUITE], 'impacted.e2e.js')
        assert.strictEqual(tests[0].meta[TEST_IS_MODIFIED], 'true')
      })
    })

    it('captures Failed Test Replay snapshots in workers', async () => {
      receiver.setSettings({
        di_enabled: true,
        flaky_test_retries_count: 1,
        flaky_test_retries_enabled: true,
      })

      await runScenario('failedTestReplay', 1, payloads => {
        const tests = getEvents(payloads)
          .filter(event => event.type === 'test')
          .map(event => event.content)
        const retriedTest = tests.find(test =>
          test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr)
        const logPayload = payloads.find(({ url }) => url.endsWith('/api/v2/logs'))

        assert.ok(retriedTest)
        assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')
        assert.ok(Object.keys(retriedTest.meta).some(tag => tag.startsWith(DI_DEBUG_ERROR_PREFIX)))
        assert.ok(logPayload)
        assert.strictEqual(logPayload.logMessage[0].ddsource, 'dd_debugger')
      }, {
        DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
        _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
      })
    })

    it('falls back safely when policy requests fail', async () => {
      receiver.setSettings({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 2 },
        },
        known_tests_enabled: true,
        test_management: { enabled: true },
      })
      receiver.setKnownTestsResponseCode(500)
      receiver.setTestManagementTestsResponseCode(500)

      await runScenario('efd', 1, payloads => {
        const events = getEvents(payloads)
        const session = events.find(event => event.type === 'test_session_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(tests.length, 1)
        assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], undefined)
        assert.strictEqual(session.meta[TEST_MANAGEMENT_ENABLED], undefined)
        for (const event of [session, ...suites, ...tests]) {
          assert.strictEqual(event.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
          assert.strictEqual(event.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
        }
      }, {}, 1)
    })
  })
}
