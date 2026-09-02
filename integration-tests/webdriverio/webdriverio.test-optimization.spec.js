'use strict'

const assert = require('node:assert/strict')
const { exec, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const {
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  DI_DEBUG_ERROR_PREFIX,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FINAL_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_MODIFIED,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_IS_RUM_ACTIVE,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_SOURCE_FILE,
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
 * @returns {Promise<{
 *   port: number,
 *   server: import('node:http').Server,
 *   getSessionCount: () => number,
 *   getRequests: () => Array<{
 *     body: {cookie?: {value: string}}|undefined,
 *     method: string|undefined,
 *     pageUrl: string|undefined,
 *     url: string|undefined
 *   }>
 * }>}
 */
function startWebDriverServer () {
  let sessionCount = 0
  let currentWindowHandle
  let windowHandles
  const windowUrls = new Map()
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.once('end', () => {
      const isNewSession = request.method === 'POST' && request.url === '/session'
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      const pageUrl = windowUrls.get(currentWindowHandle)
      let value = null

      if (isNewSession) {
        sessionCount++
        currentWindowHandle = 'window-a'
        windowHandles = ['window-a']
        windowUrls.clear()
        windowUrls.set(currentWindowHandle, 'about:blank')
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
      } else if (request.method === 'GET' && request.url?.endsWith('/window')) {
        value = currentWindowHandle
      } else if (request.method === 'GET' && request.url?.endsWith('/window/handles')) {
        value = windowHandles
      } else if (request.method === 'POST' && request.url?.endsWith('/window')) {
        currentWindowHandle = body.handle
      } else if (request.method === 'DELETE' && request.url?.endsWith('/window')) {
        windowHandles = windowHandles.filter(windowHandle => windowHandle !== currentWindowHandle)
        windowUrls.delete(currentWindowHandle)
        currentWindowHandle = windowHandles[0]
        value = windowHandles
      } else if (request.method === 'GET' && request.url?.endsWith('/url')) {
        value = windowUrls.get(currentWindowHandle)
      } else if (request.method === 'POST' && request.url?.endsWith('/url')) {
        windowUrls.set(currentWindowHandle, body.url)
      } else if (request.method === 'POST' && request.url?.endsWith('/execute/sync')) {
        if (body.script.includes('getInternalContext')) {
          value = { isRumActive: true, isRumInstrumented: true, rumSamplingRate: 100 }
        } else if (body.script.includes('window.open')) {
          const cleanupWindowHandle = `window-${windowHandles.length + 1}`
          windowHandles.push(cleanupWindowHandle)
          windowUrls.set(cleanupWindowHandle, body.args[0])
        } else {
          value = true
        }
      }

      requests.push({
        body,
        method: request.method,
        pageUrl,
        url: request.url,
      })

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
        getRequests: () => requests,
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

/**
 * Gets automatic log-submission requests from intake payloads.
 *
 * @param {object[]} payloads
 * @returns {object[]}
 */
function getLogRequests (payloads) {
  return payloads.filter(({ url }) => url.startsWith('/api/v2/logs?'))
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
      `@wdio/jasmine-framework@${version}`,
      `@wdio/local-runner@${version}`,
      `@wdio/mocha-framework@${version}`,
      'bunyan',
      'pino',
      'winston',
    ], true, [
      './integration-tests/webdriverio/fixtures/*',
      './integration-tests/ci-visibility/dynamic-instrumentation/dependency.js',
    ])

    before(async function () {
      cwd = sandboxCwd()
      webDriver = await startWebDriverServer()

      execFileSync('git', ['switch', '-c', 'feature-branch'], { cwd })
      fs.appendFileSync(path.join(cwd, 'impacted.e2e.js'), '\n// modified by the integration test\n')
      fs.appendFileSync(
        path.join(cwd, 'subdirectory', 'nested-impacted.e2e.js'),
        '\n// modified by the integration test\n'
      )
      execFileSync('git', ['add', 'impacted.e2e.js', 'subdirectory/nested-impacted.e2e.js'], { cwd })
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
     * @param {'mocha'|'jasmine'} framework
     * @param {string} scenario
     * @param {number} expectedWebDriverSessions
     * @param {(payloads: object[], requests: object[]) => void} assertPayloads
     * @param {object} [extraEnvironment]
     * @param {number} [expectedExitCode]
     * @param {string} [workingDirectory]
     * @returns {Promise<void>}
     */
    async function runFrameworkScenario (
      framework,
      scenario,
      expectedWebDriverSessions,
      assertPayloads,
      extraEnvironment = {},
      expectedExitCode = 0,
      workingDirectory = cwd
    ) {
      const initialWebDriverSessionCount = webDriver.getSessionCount()
      const initialWebDriverRequestCount = webDriver.getRequests().length
      const executable = path.join(cwd, 'node_modules', '.bin', 'wdio')
      childProcess = exec(`"${executable}" run ./wdio.conf.js`, {
        cwd: workingDirectory,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE: 'false',
          NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
          DD_TEST_SESSION_NAME: 'webdriverio-test-optimization',
          GITHUB_BASE_REF: '',
          WEBDRIVERIO_FRAMEWORK: framework,
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
        payloads => assertPayloads(
          payloads,
          webDriver.getRequests().slice(initialWebDriverRequestCount)
        ),
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

    for (const framework of ['mocha', 'jasmine']) {
      describe(`${framework} adapter`, function () {
        /**
         * Runs one optimization scenario for this adapter.
         *
         * @param {string} scenario
         * @param {number} expectedWebDriverSessions
         * @param {(payloads: object[], requests: object[]) => void} assertPayloads
         * @param {object} [extraEnvironment]
         * @param {number} [expectedExitCode]
         * @param {string} [workingDirectory]
         * @returns {Promise<void>}
         */
        function runScenario (
          scenario,
          expectedWebDriverSessions,
          assertPayloads,
          extraEnvironment,
          expectedExitCode,
          workingDirectory
        ) {
          return runFrameworkScenario(
            framework,
            scenario,
            expectedWebDriverSessions,
            assertPayloads,
            extraEnvironment,
            expectedExitCode,
            workingDirectory
          )
        }

        if (version === 'latest') {
          describe('automatic log submission', () => {
            const loggers = {
              bunyan: { level: 30, messageKey: 'msg' },
              pino: { level: 30, messageKey: 'msg' },
              winston: { level: 'info', messageKey: 'message' },
            }

            for (const [loggerName, { level: expectedLevel, messageKey }] of Object.entries(loggers)) {
              describe(`with ${loggerName}`, () => {
                it('submits correlated logs', async () => {
                  await runScenario('automaticLogSubmission', 1, payloads => {
                    const logRequests = getLogRequests(payloads)

                    assert.ok(logRequests.length > 0)
                    for (const logRequest of logRequests) {
                      assert.strictEqual(logRequest.headers['dd-api-key'], '1')
                      assert.strictEqual(logRequest.headers['content-type'], 'application/json')
                      assert.strictEqual(
                        logRequest.url,
                        `/api/v2/logs?ddsource=${loggerName}&service=my-service`
                      )
                    }

                    const logMessages = logRequests.flatMap(({ logMessage }) => logMessage)
                    assert.strictEqual(logMessages.length, 2)

                    const logMessage = logMessages.find(
                      logMessage => logMessage[messageKey] === 'Hello from WebdriverIO!'
                    )
                    const afterHookLogMessage = logMessages.find(
                      logMessage => logMessage[messageKey] === 'Hello from WebdriverIO after hook!'
                    )
                    const test = getEvents(payloads).find(event => event.type === 'test').content

                    assert.ok(logMessage)
                    assert.strictEqual(logMessage.level, expectedLevel)
                    assert.deepStrictEqual(Object.keys(logMessage.dd).sort(), ['service', 'span_id', 'trace_id'])
                    assert.strictEqual(logMessage.dd.service, 'my-service')
                    assert.strictEqual(logMessage.dd.span_id, test.span_id.toString())
                    assert.strictEqual(logMessage.dd.trace_id, test.trace_id.toString())
                    assert.ok(afterHookLogMessage)
                    assert.strictEqual(afterHookLogMessage.level, expectedLevel)
                  }, {
                    DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
                    DD_AGENTLESS_LOG_SUBMISSION_URL: `http://127.0.0.1:${receiver.port}`,
                    DD_SERVICE: 'my-service',
                    TEST_LOGGER: loggerName,
                  })

                  assert.match(testOutput, /Hello from WebdriverIO!/)
                })

                it('does not submit logs when automatic submission is disabled', async () => {
                  await runScenario('automaticLogSubmission', 1, payloads => {
                    assert.strictEqual(getLogRequests(payloads).length, 0)
                  }, {
                    DD_AGENTLESS_LOG_SUBMISSION_URL: `http://127.0.0.1:${receiver.port}`,
                    DD_SERVICE: 'my-service',
                    TEST_LOGGER: loggerName,
                  })

                  assert.match(testOutput, /Hello from WebdriverIO!/)
                  assert.match(testOutput, /span_id/)
                })

                it('does not submit logs when the API key is missing', async () => {
                  await runScenario('automaticLogSubmission', 1, payloads => {
                    assert.strictEqual(getLogRequests(payloads).length, 0)
                  }, {
                    ...getCiVisEvpProxyConfig(receiver.port),
                    DD_AGENTLESS_LOG_SUBMISSION_ENABLED: '1',
                    DD_AGENTLESS_LOG_SUBMISSION_URL: `http://127.0.0.1:${receiver.port}`,
                    DD_API_KEY: '',
                    DD_SERVICE: 'my-service',
                    NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
                    TEST_LOGGER: loggerName,
                  })

                  assert.match(testOutput, /Hello from WebdriverIO!/)
                  assert.match(testOutput, /span_id/)
                })
              })
            }
          })
        }

        it('correlates tests with RUM sessions', async () => {
          await runScenario('rum', 1, (payloads, requests) => {
            const test = getEvents(payloads).find(event => event.type === 'test').content
            assert.strictEqual(test.meta[TEST_IS_RUM_ACTIVE], 'true')
            assert.strictEqual(test.meta[TEST_BROWSER_NAME], 'chrome')
            assert.strictEqual(test.meta[TEST_BROWSER_VERSION], 'test')
            assert.ok(requests.some(({ url }) => url?.endsWith('/refresh')))

            const cookieRequests = requests.filter(({ url }) => url?.includes('/cookie'))
            const setCookieRequests = cookieRequests.filter(({ method }) => method === 'POST')
            assert.deepStrictEqual(
              setCookieRequests.map(({ body }) => body.cookie.value),
              [test.trace_id.toString(10), test.trace_id.toString(10), test.trace_id.toString(10)]
            )
            assert.deepStrictEqual(
              cookieRequests.map(({ method }) => method),
              ['POST', 'POST', 'POST', 'DELETE', 'DELETE', 'DELETE', 'DELETE']
            )
            assert.deepStrictEqual(
              cookieRequests.filter(({ method }) => method === 'DELETE').map(({ pageUrl }) => pageUrl),
              [
                'http://after-each.example.test/',
                'http://example.test/',
                'http://second.example.test/',
                'http://after-each.example.test/',
              ]
            )
          })
        })

        it('re-correlates a reused RUM page between tests without afterEach hooks', async () => {
          await runScenario('rumNoAfterEach', 1, (payloads, requests) => {
            const tests = getEvents(payloads)
              .filter(event => event.type === 'test')
              .map(event => event.content)
            const cookieRequests = requests.filter(({ url }) => url?.includes('/cookie'))

            assert.deepStrictEqual(
              cookieRequests.map(({ method }) => method),
              ['POST', 'DELETE', 'POST', 'DELETE']
            )
            assert.deepStrictEqual(
              cookieRequests.filter(({ method }) => method === 'POST').map(({ body }) => body.cookie.value),
              tests.map(test => test.trace_id.toString(10))
            )
            assert.deepStrictEqual(
              cookieRequests.filter(({ method }) => method === 'DELETE').map(({ pageUrl }) => pageUrl),
              ['http://first.example.test/', 'http://first.example.test/']
            )
          })
        })

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
            assert.strictEqual(
              session.meta[TEST_STATUS],
              'pass',
              JSON.stringify(tests.map(test => test.meta))
            )
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

        it('keeps quarantine metadata on EFD retries of a new test', async () => {
          const numRetries = 2
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: { '5s': numRetries },
            },
            known_tests_enabled: true,
            test_management: { enabled: true },
          })
          receiver.setKnownTests({ webdriverio: {} })
          receiver.setTestManagementTests({
            webdriverio: {
              suites: {
                'atr-always-fail.e2e.js': {
                  tests: {
                    'WebdriverIO ATR fails every retry': {
                      properties: { quarantined: true },
                    },
                  },
                },
              },
            },
          })

          await runScenario('atrAlwaysFails', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const suite = events.find(event => event.type === 'test_suite_end').content
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(session.meta[TEST_STATUS], 'pass')
            assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
            assert.strictEqual(tests.length, numRetries + 1)
            for (const test of tests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            }

            const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retries.length, numRetries)
            assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd))

            const finalAttempt = tests.find(test => TEST_FINAL_STATUS in test.meta)
            assert.ok(finalAttempt)
            assert.strictEqual(finalAttempt.meta[TEST_FINAL_STATUS], 'skip')
            assert.strictEqual(finalAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          })
        })

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('keeps skipped tests and their suite and session successful with EFD', async () => {
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                faulty_session_threshold: 100,
                slow_test_retries: { '5s': 2 },
              },
              known_tests_enabled: true,
            })
            receiver.setKnownTests({ webdriverio: {} })

            await runScenario('jasmineEfdSkipped', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const passingTests = tests.filter(test => test.meta[TEST_NAME].endsWith('passes'))
              const skippedTests = tests.filter(test => test.meta[TEST_NAME].endsWith('stays skipped'))

              assert.strictEqual(session.meta[TEST_STATUS], 'pass')
              assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
              assert.strictEqual(passingTests.length, 3)
              assert.ok(passingTests.every(test => test.meta[TEST_STATUS] === 'pass'))
              assert.strictEqual(
                passingTests.filter(test => test.meta[TEST_FINAL_STATUS] === 'pass').length,
                1
              )
              assert.strictEqual(skippedTests.length, 1)
              assert.strictEqual(skippedTests[0].meta[TEST_STATUS], 'skip')
              assert.strictEqual(skippedTests[0].meta[TEST_FINAL_STATUS], 'skip')
              assert.strictEqual(skippedTests[0].meta[TEST_IS_NEW], 'true')
              assert.strictEqual(skippedTests[0].meta[TEST_IS_RETRY], undefined)
              assert.strictEqual(skippedTests[0].meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
            })
          })
        }

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('keeps tests filtered by jasmineOpts.grep skipped with EFD', async () => {
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                faulty_session_threshold: 100,
                slow_test_retries: { '5s': 2 },
              },
              known_tests_enabled: true,
            })
            receiver.setKnownTests({ webdriverio: {} })

            await runScenario('jasmineFiltered', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const selectedTests = tests.filter(test => test.meta[TEST_NAME].endsWith('runs selected test'))
              const filteredTests = tests.filter(test => test.meta[TEST_NAME].endsWith('stays filtered'))

              assert.strictEqual(session.meta[TEST_STATUS], 'pass')
              assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
              assert.strictEqual(selectedTests.length, 3)
              assert.ok(selectedTests.every(test => test.meta[TEST_STATUS] === 'pass'))
              assert.strictEqual(filteredTests.length, 1)
              assert.strictEqual(filteredTests[0].meta[TEST_STATUS], 'skip')
              assert.strictEqual(filteredTests[0].meta[TEST_FINAL_STATUS], 'skip')
              assert.strictEqual(filteredTests[0].meta[TEST_IS_RETRY], undefined)
            })
          })
        }

        it('uses the first attempt duration to select the EFD retry count', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: {
                '5s': 0,
                '10s': 2,
              },
            },
            known_tests_enabled: true,
          })
          receiver.setKnownTests({ webdriverio: {} })

          await runScenario('efd', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            assert.strictEqual(tests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
            assert.strictEqual(tests[0].meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
            assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
          }, {}, 1)
        })

        it('does not retry EFD tests when locally disabled', async () => {
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
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], undefined)
            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests[0].meta[TEST_IS_NEW], 'true')
            assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
          }, {
            DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
          }, 1)
        })

        it('does not retry disabled modified or new tests with EFD', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: { '5s': 2 },
            },
            impacted_tests_enabled: true,
            known_tests_enabled: true,
            test_management: { enabled: true },
          })
          receiver.setKnownTests({
            webdriverio: {
              'first.e2e.js': ['WebdriverIO first worker runs with an active Test Optimization span'],
              'impacted.e2e.js': ['WebdriverIO impacted tests marks a modified test'],
            },
          })
          receiver.setTestManagementTests({
            webdriverio: {
              suites: {
                'disabled-efd.e2e.js': {
                  tests: {
                    'WebdriverIO disabled EFD is new': {
                      properties: { disabled: true },
                    },
                  },
                },
                'impacted.e2e.js': {
                  tests: {
                    'WebdriverIO impacted tests marks a modified test': {
                      properties: { disabled: true },
                    },
                  },
                },
              },
            },
          })

          await runScenario('disabledEfd', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const disabledTests = tests.filter(test => test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true')
            const modified = disabledTests.find(test => test.meta[TEST_SUITE] === 'impacted.e2e.js')
            const newTest = disabledTests.find(test => test.meta[TEST_SUITE] === 'disabled-efd.e2e.js')

            assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            assert.strictEqual(session.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.deepStrictEqual(
              tests.map(test => test.meta[TEST_SUITE]).sort(),
              ['disabled-efd.e2e.js', 'first.e2e.js', 'impacted.e2e.js']
            )
            assert.strictEqual(disabledTests.length, 2)
            for (const test of disabledTests) {
              assert.strictEqual(test.meta[TEST_STATUS], 'skip')
              assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'skip')
              assert.strictEqual(test.meta[TEST_IS_RETRY], undefined)
            }
            assert.strictEqual(modified.meta[TEST_IS_MODIFIED], 'true')
            assert.strictEqual(modified.meta[TEST_IS_NEW], undefined)
            assert.strictEqual(newTest.meta[TEST_IS_MODIFIED], undefined)
            assert.strictEqual(newTest.meta[TEST_IS_NEW], 'true')
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

        it('treats known-tests data missing both supported framework keys as faulty', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: { '5s': 2 },
            },
            known_tests_enabled: true,
          })
          receiver.setKnownTests({ 'not-webdriverio': {} })

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

        it('evaluates EFD faultiness from specs that have not started yet', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 1,
              slow_test_retries: { '5s': 2 },
            },
            known_tests_enabled: true,
          })
          receiver.setKnownTests({
            webdriverio: {
              'first.e2e.js': ['WebdriverIO first worker runs with an active Test Optimization span'],
            },
          })

          await runScenario('efdFaultySchedule', 2, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const efdTests = events
              .filter(event => event.type === 'test')
              .map(event => event.content)
              .filter(test => test.meta[TEST_NAME].endsWith('retries a new test'))

            assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ENABLED], undefined)
            assert.strictEqual(session.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')
            assert.strictEqual(efdTests.length, 1)
            assert.strictEqual(efdTests[0].meta[TEST_IS_NEW], undefined)
            assert.strictEqual(efdTests[0].meta[TEST_IS_RETRY], undefined)
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

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('falls back to ATR when the EFD retry policy has no retries', async () => {
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                faulty_session_threshold: 100,
                slow_test_retries: { '5s': 0 },
              },
              flaky_test_retries_count: 1,
              flaky_test_retries_enabled: true,
              known_tests_enabled: true,
            })
            receiver.setKnownTests({ webdriverio: {} })

            await runScenario('atr', 1, payloads => {
              const tests = getEvents(payloads)
                .filter(event => event.type === 'test')
                .map(event => event.content)

              assert.strictEqual(tests.length, 2)
              assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['fail', 'pass'])
              assert.ok(tests.every(test => test.meta[TEST_IS_NEW] === 'true'))
              assert.ok(tests.every(test => test.meta[TEST_EARLY_FLAKE_ABORT_REASON] === undefined))
              const retry = tests.find(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.ok(retry)
              assert.strictEqual(retry.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
            })
          })
        }

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('does not retry tests with ATR when their hooks fail', async () => {
            receiver.setSettings({
              flaky_test_retries_count: 1,
              flaky_test_retries_enabled: true,
            })

            await runScenario('atrHookFailures', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(session.meta[TEST_STATUS], 'fail')
              assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
              assert.strictEqual(tests.length, 2)
              assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
              assert.ok(tests.every(test => test.meta[TEST_IS_RETRY] === undefined))
              assert.ok(tests.every(test => test.meta[TEST_HAS_FAILED_ALL_RETRIES] === undefined))
            }, {}, 1)
          })
        }

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('applies ATR before WebdriverIO retries the spec file', async () => {
            receiver.setSettings({
              flaky_test_retries_count: 1,
              flaky_test_retries_enabled: true,
            })

            await runScenario('specFileRetries', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(countRequests(payloads, SETTINGS_PATH), 1)
              assert.strictEqual(session.meta[TEST_STATUS], 'pass')
              assert.strictEqual(suites.length, 1)
              assert.strictEqual(suites[0].meta[TEST_STATUS], 'pass')
              assert.strictEqual(tests.length, 2)
              assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['fail', 'pass'])
              assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
            }, {
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            })
          })
        }

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('applies ATR to failures caused by jasmineOpts.failSpecWithNoExpectations', async () => {
            receiver.setSettings({
              flaky_test_retries_count: 1,
              flaky_test_retries_enabled: true,
            })

            await runScenario('jasmineNoExpectations', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(session.meta[TEST_STATUS], 'fail')
              assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
              assert.strictEqual(tests.length, 2)
              assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
              assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
              assert.strictEqual(tests[1].meta[TEST_FINAL_STATUS], 'fail')
            }, {
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            }, 1)
          })
        }

        it('reports exhausted ATR retries', async () => {
          receiver.setSettings({
            flaky_test_retries_count: 2,
            flaky_test_retries_enabled: true,
          })

          await runScenario('atrAlwaysFails', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const suite = events.find(event => event.type === 'test_suite_end').content
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(session.meta[TEST_STATUS], 'fail')
            assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
            assert.strictEqual(tests.length, 3)
            assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
            assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 2)
            for (const test of tests.slice(1)) {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
            }
            const finalAttempt = tests.find(test => TEST_FINAL_STATUS in test.meta)
            assert.ok(finalAttempt)
            assert.strictEqual(finalAttempt.meta[TEST_FINAL_STATUS], 'fail')
            assert.strictEqual(finalAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          }, {
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
          }, 1)
        })

        it('does not retry ATR failures when locally disabled', async () => {
          receiver.setSettings({
            flaky_test_retries_count: 2,
            flaky_test_retries_enabled: true,
          })

          await runScenario('atrAlwaysFails', 1, payloads => {
            const tests = getEvents(payloads)
              .filter(event => event.type === 'test')
              .map(event => event.content)

            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
            assert.strictEqual(tests[0].meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
          }, {
            DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
          }, 1)
        })

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('reports user-configured Jasmine retries as external retries', async () => {
            await runScenario('jasmineRetry', 1, payloads => {
              const tests = getEvents(payloads)
                .filter(event => event.type === 'test')
                .map(event => event.content)

              assert.strictEqual(tests.length, 2)
              assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['fail', 'pass'])
              assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
              assert.strictEqual(tests[1].meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
            })
          })
        }

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
                    'WebdriverIO Test Management fails every attempt to fix': {
                      properties: { attempt_to_fix: true },
                    },
                    'WebdriverIO Test Management has mixed attempt to fix results': {
                      properties: { attempt_to_fix: true },
                    },
                    'WebdriverIO Test Management passes every attempt to fix': {
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
            const allPassed = tests.filter(test => test.meta[TEST_NAME].endsWith('passes every attempt to fix'))
            const allFailed = tests.filter(test => test.meta[TEST_NAME].endsWith('fails every attempt to fix'))
            const mixed = tests.filter(test => test.meta[TEST_NAME].endsWith('has mixed attempt to fix results'))

            assert.strictEqual(countRequests(payloads, TEST_MANAGEMENT_PATH), 1)
            assert.strictEqual(session.meta[TEST_MANAGEMENT_ENABLED], 'true')
            assert.strictEqual(disabled.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabled.meta[TEST_FINAL_STATUS], 'skip')
            assert.strictEqual(disabled.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(quarantined.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantined.meta[TEST_FINAL_STATUS], 'skip')
            assert.strictEqual(quarantined.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            for (const attempts of [allPassed, allFailed, mixed]) {
              assert.strictEqual(attempts.length, 3)
            }
            for (const test of [...allPassed, ...allFailed, ...mixed]) {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
            }
            for (const attempts of [allPassed, allFailed, mixed]) {
              for (const test of attempts.slice(1)) {
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atf)
              }
            }

            const finalPassed = allPassed.find(test => TEST_FINAL_STATUS in test.meta)
            const finalFailed = allFailed.find(test => TEST_FINAL_STATUS in test.meta)
            const finalMixed = mixed.find(test => TEST_FINAL_STATUS in test.meta)
            assert.strictEqual(finalPassed.meta[TEST_FINAL_STATUS], 'pass')
            assert.strictEqual(finalPassed.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'true')
            assert.strictEqual(finalFailed.meta[TEST_FINAL_STATUS], 'fail')
            assert.strictEqual(finalFailed.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
            assert.strictEqual(finalFailed.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
            assert.strictEqual(finalMixed.meta[TEST_FINAL_STATUS], 'fail')
            assert.strictEqual(finalMixed.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], 'false')
            assert.strictEqual(finalMixed.meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
          }, {}, 1)
        })

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('keeps skipped attempt-to-fix tests skipped', async () => {
            receiver.setSettings({
              test_management: {
                attempt_to_fix_retries: 2,
                enabled: true,
              },
            })
            receiver.setTestManagementTests({
              webdriverio: {
                suites: {
                  'jasmine-attempt-to-fix-skipped.e2e.js': {
                    tests: {
                      'WebdriverIO Jasmine skipped attempt to fix stays skipped': {
                        properties: { attempt_to_fix: true },
                      },
                    },
                  },
                },
              },
            })

            await runScenario('jasmineAttemptToFixSkipped', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              assert.strictEqual(session.meta[TEST_STATUS], 'skip')
              assert.strictEqual(suite.meta[TEST_STATUS], 'skip')
              assert.strictEqual(tests.length, 1)
              assert.strictEqual(tests[0].meta[TEST_STATUS], 'skip')
              assert.strictEqual(tests[0].meta[TEST_FINAL_STATUS], 'skip')
              assert.strictEqual(tests[0].meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
              assert.strictEqual(tests[0].meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], undefined)
              assert.strictEqual(tests[0].meta[TEST_IS_RETRY], undefined)
              assert.strictEqual(tests[0].meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
            })
          })

          jasmineTest('does not run hooks for disabled tests', async () => {
            receiver.setSettings({
              test_management: { enabled: true },
            })
            receiver.setTestManagementTests({
              webdriverio: {
                suites: {
                  'test-management-disabled-hook.e2e.js': {
                    tests: {
                      'WebdriverIO disabled hook is disabled': {
                        properties: { disabled: true },
                      },
                    },
                  },
                },
              },
            })

            await runScenario('testManagementDisabledHook', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const disabled = tests.find(test => test.meta[TEST_NAME].endsWith('is disabled'))
              const passing = tests.find(test => test.meta[TEST_NAME].endsWith('passes'))

              assert.strictEqual(session.meta[TEST_STATUS], 'pass')
              assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
              assert.strictEqual(disabled.meta[TEST_STATUS], 'skip')
              assert.strictEqual(disabled.meta[TEST_FINAL_STATUS], 'skip')
              assert.strictEqual(disabled.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              assert.strictEqual(passing.meta[TEST_STATUS], 'pass')
            }, {}, 0)
          })
        }

        it('does not apply Test Management policies when locally disabled', async () => {
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
                    'WebdriverIO Test Management is disabled': {
                      properties: { disabled: true },
                    },
                    'WebdriverIO Test Management is quarantined': {
                      properties: { quarantined: true },
                    },
                    'WebdriverIO Test Management passes every attempt to fix': {
                      properties: { attempt_to_fix: true },
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

            assert.strictEqual(countRequests(payloads, TEST_MANAGEMENT_PATH), 0)
            assert.strictEqual(session.meta[TEST_MANAGEMENT_ENABLED], undefined)
            assert.strictEqual(tests.length, 5)
            for (const test of tests) {
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], undefined)
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], undefined)
              assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], undefined)
              assert.strictEqual(test.meta[TEST_IS_RETRY], undefined)
            }
          }, {
            DD_TEST_MANAGEMENT_ENABLED: '0',
          }, 1)
        })

        it('suppresses quarantined and recovered EFD hook failures', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: { '5s': 2 },
            },
            known_tests_enabled: true,
            test_management: { enabled: true },
          })
          receiver.setKnownTests({
            webdriverio: {
              'managed-hook-fail.e2e.js': ['WebdriverIO quarantined hook failure is quarantined'],
            },
          })
          receiver.setTestManagementTests({
            webdriverio: {
              suites: {
                'managed-hook-fail.e2e.js': {
                  tests: {
                    'WebdriverIO quarantined hook failure is quarantined': {
                      properties: { quarantined: true },
                    },
                  },
                },
              },
            },
          })

          await runScenario('managedHookFailures', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const suite = events.find(event => event.type === 'test_suite_end').content
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const quarantined = tests.find(test => test.meta[TEST_NAME].endsWith('is quarantined'))
            const earlyFlakeDetectionTests = tests.filter(test =>
              test.meta[TEST_NAME].endsWith('passes an EFD retry'))

            assert.strictEqual(session.meta[TEST_STATUS], 'pass')
            assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
            assert.strictEqual(quarantined.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantined.meta[TEST_FINAL_STATUS], 'skip')
            assert.strictEqual(quarantined.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            const expectedStatuses = framework === 'jasmine' ? ['fail', 'pass', 'pass'] : ['fail', 'pass']
            assert.strictEqual(earlyFlakeDetectionTests.length, expectedStatuses.length)
            assert.deepStrictEqual(
              earlyFlakeDetectionTests.map(test => test.meta[TEST_STATUS]).sort(),
              expectedStatuses
            )
          })
        })

        it('fails the run when every EFD attempt has a failing afterEach hook', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: { '5s': 2 },
            },
            known_tests_enabled: true,
          })
          receiver.setKnownTests({ webdriverio: {} })

          await runScenario('efdAfterEachFailure', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const suite = events.find(event => event.type === 'test_suite_end').content
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(session.meta[TEST_STATUS], 'fail')
            assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
            assert.strictEqual(tests.length, framework === 'jasmine' ? 3 : 1)
            assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
          }, {}, 1)
        })

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('does not retry or suppress expectation-based hook failures', async () => {
            receiver.setSettings({
              early_flake_detection: {
                enabled: true,
                faulty_session_threshold: 100,
                slow_test_retries: { '5s': 2 },
              },
              flaky_test_retries_count: 1,
              flaky_test_retries_enabled: true,
              known_tests_enabled: true,
            })
            receiver.setKnownTests({
              webdriverio: {
                'jasmine-expectation-hook-fail.e2e.js': [
                  'WebdriverIO Jasmine expectation hook failures beforeEach does not retry with ATR',
                ],
              },
            })

            await runScenario('jasmineExpectationHookFailures', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const beforeEachTests = tests.filter(test => test.meta[TEST_NAME].endsWith('does not retry with ATR'))
              const afterEachTests = tests.filter(test => test.meta[TEST_NAME].endsWith('keeps the final EFD failure'))

              assert.strictEqual(session.meta[TEST_STATUS], 'fail')
              assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
              assert.strictEqual(beforeEachTests.length, 1)
              assert.strictEqual(beforeEachTests[0].meta[TEST_STATUS], 'fail')
              assert.strictEqual(beforeEachTests[0].meta[TEST_IS_RETRY], undefined)
              assert.deepStrictEqual(afterEachTests.map(test => test.meta[TEST_STATUS]), ['pass', 'pass', 'fail'])
              assert.strictEqual(afterEachTests[2].meta[TEST_FINAL_STATUS], 'fail')
            }, {}, 1)
          })
        }

        for (const hookType of ['beforeAll', 'afterAll']) {
          it(`does not suppress a quarantined test's ${hookType} failure`, async () => {
            receiver.setSettings({
              test_management: { enabled: true },
            })
            receiver.setTestManagementTests({
              webdriverio: {
                suites: {
                  'suite-hook-fail.e2e.js': {
                    tests: {
                      'WebdriverIO suite hook failure is quarantined': {
                        properties: { quarantined: true },
                      },
                    },
                  },
                },
              },
            })

            await runScenario('suiteHookFailure', 1, payloads => {
              const events = getEvents(payloads)
              const session = events.find(event => event.type === 'test_session_end').content
              const suite = events.find(event => event.type === 'test_suite_end').content

              assert.strictEqual(session.meta[TEST_STATUS], 'fail')
              assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
            }, {
              WEBDRIVERIO_SUITE_HOOK: hookType,
            }, framework === 'jasmine' ? 0 : 1)
          })
        }

        it('does not suppress an afterAll failure after passing EFD attempts', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              faulty_session_threshold: 100,
              slow_test_retries: { '5s': 2 },
            },
            known_tests_enabled: true,
          })
          receiver.setKnownTests({ webdriverio: {} })

          await runScenario('suiteHookFailure', 1, payloads => {
            const events = getEvents(payloads)
            const session = events.find(event => event.type === 'test_session_end').content
            const suite = events.find(event => event.type === 'test_suite_end').content

            assert.strictEqual(session.meta[TEST_STATUS], 'fail')
            assert.strictEqual(suite.meta[TEST_STATUS], 'fail')
          }, {
            WEBDRIVERIO_SUITE_HOOK: 'afterAll',
          }, framework === 'jasmine' ? 0 : 1)
        })

        it('marks tests from modified files as impacted', async () => {
          receiver.setSettings({ impacted_tests_enabled: true })

          await runScenario('impacted', 1, payloads => {
            const tests = getEvents(payloads)
              .filter(event => event.type === 'test')
              .map(event => event.content)
            const impacted = tests.find(test => test.meta[TEST_SUITE] === 'impacted.e2e.js')
            const unmodified = tests.find(test => test.meta[TEST_SUITE] === 'first.e2e.js')

            assert.strictEqual(tests.length, 2)
            assert.strictEqual(impacted.meta[TEST_IS_MODIFIED], 'true')
            assert.strictEqual(unmodified.meta[TEST_IS_MODIFIED], undefined)
          })
        })

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('marks tests as impacted when WebdriverIO runs below the repository root', async () => {
            receiver.setSettings({ impacted_tests_enabled: true })

            await runScenario('impacted', 1, payloads => {
              const tests = getEvents(payloads)
                .filter(event => event.type === 'test')
                .map(event => event.content)
              const impacted = tests.find(test => test.meta[TEST_SUITE] === 'nested-impacted.e2e.js')
              const unmodified = tests.find(test => test.meta[TEST_SUITE] === 'nested-first.e2e.js')

              assert.strictEqual(tests.length, 2)
              assert.strictEqual(impacted.meta[TEST_SOURCE_FILE], 'subdirectory/nested-impacted.e2e.js')
              assert.strictEqual(impacted.meta[TEST_IS_MODIFIED], 'true')
              assert.strictEqual(unmodified.meta[TEST_IS_MODIFIED], undefined)
            }, {}, 0, path.join(cwd, 'subdirectory'))
          })
        }

        it('does not mark impacted tests when locally disabled', async () => {
          receiver.setSettings({ impacted_tests_enabled: true })

          await runScenario('impacted', 1, payloads => {
            const tests = getEvents(payloads)
              .filter(event => event.type === 'test')
              .map(event => event.content)

            assert.strictEqual(tests.length, 2)
            assert.ok(tests.every(test => test.meta[TEST_IS_MODIFIED] === undefined))
          }, {
            DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0',
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

        {
          const jasmineTest = framework === 'jasmine' ? it : it.skip
          jasmineTest('captures Failed Test Replay when the first EFD attempt passes', async () => {
            receiver.setSettings({
              di_enabled: true,
              early_flake_detection: {
                enabled: true,
                faulty_session_threshold: 100,
                slow_test_retries: { '5s': 2 },
              },
              flaky_test_retries_count: 1,
              flaky_test_retries_enabled: true,
              known_tests_enabled: true,
            })
            receiver.setKnownTests({ webdriverio: {} })

            await runScenario('efdFailedTestReplay', 1, payloads => {
              const tests = getEvents(payloads)
                .filter(event => event.type === 'test')
                .map(event => event.content)
              const finalRetry = tests[2]
              const logPayload = payloads.find(({ url }) => url.endsWith('/api/v2/logs'))

              assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['pass', 'fail', 'pass'])
              assert.strictEqual(finalRetry.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
              assert.strictEqual(
                finalRetry.meta[DI_ERROR_DEBUG_INFO_CAPTURED],
                'true',
                JSON.stringify(tests.map(test => test.meta))
              )
              assert.ok(Object.keys(finalRetry.meta).some(tag => tag.startsWith(DI_DEBUG_ERROR_PREFIX)))
              assert.ok(logPayload)
              assert.strictEqual(logPayload.logMessage[0].ddsource, 'dd_debugger')
            }, {
              _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
            })
          })
        }

        it('does not capture Failed Test Replay snapshots when locally disabled', async () => {
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
            assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], undefined)
            assert.ok(!Object.keys(retriedTest.meta).some(tag => tag.startsWith(DI_DEBUG_ERROR_PREFIX)))
            assert.strictEqual(logPayload, undefined)
          }, {
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
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
  })
}
