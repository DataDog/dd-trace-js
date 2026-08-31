'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')

const {
  getCiVisAgentlessConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  MOCHA_IS_PARALLEL,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_ADAPTER,
  TEST_FRAMEWORK_VERSION,
  TEST_IS_RETRY,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MODULE,
  TEST_STATUS,
  TEST_SUITE,
  TEST_TYPE,
} = require('../../packages/dd-trace/src/plugins/util/test')

const OLDEST_WEBDRIVERIO_VERSION = '9.0.0'
const requestedVersion = process.env.WEBDRIVERIO_VERSION
const versions = requestedVersion
  ? [requestedVersion === 'oldest' ? OLDEST_WEBDRIVERIO_VERSION : requestedVersion]
  : [OLDEST_WEBDRIVERIO_VERSION, 'latest']

const disabledSettings = {
  code_coverage: false,
  tests_skipping: false,
  itr_enabled: false,
  require_git: false,
  early_flake_detection: {
    enabled: false,
  },
  flaky_test_retries_enabled: false,
  di_enabled: false,
  known_tests_enabled: false,
  test_management: {
    enabled: false,
  },
  impacted_tests_enabled: false,
  coverage_report_upload_enabled: false,
}

const advancedRequestPaths = [
  '/api/v2/ci/libraries/tests',
  '/api/v2/ci/tests/skippable',
  '/api/v2/test/libraries/test-management/tests',
]

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
 * Asserts every child event belongs to the coordinator-owned session and module.
 *
 * @param {object} session
 * @param {object} module
 * @param {object[]} suites
 * @param {object[]} tests
 * @returns {void}
 */
function assertEventHierarchy (session, module, suites, tests) {
  const sessionId = session.test_session_id.toString(10)
  const moduleId = module.test_module_id.toString(10)

  assert.strictEqual(module.test_session_id.toString(10), sessionId)

  for (const event of [...suites, ...tests]) {
    assert.strictEqual(event.test_session_id.toString(10), sessionId)
    assert.strictEqual(event.test_module_id.toString(10), moduleId)
  }

  const suiteIds = new Set(suites.map(suite => suite.test_suite_id.toString(10)))
  for (const test of tests) {
    assert.ok(suiteIds.has(test.test_suite_id.toString(10)))
  }
}

/**
 * Asserts each repeated suite execution owns exactly one test event.
 *
 * @param {object[]} suites
 * @param {object[]} tests
 * @returns {void}
 */
function assertOneTestPerSuiteExecution (suites, tests) {
  assert.deepStrictEqual(
    tests.map(test => test.test_suite_id.toString(10)).sort(),
    suites.map(suite => suite.test_suite_id.toString(10)).sort()
  )
}

/**
 * Extracts events and verifies the WebdriverIO run kept TIA disabled.
 *
 * @param {object[]} payloads
 * @param {string} requestedVersion
 * @param {string} frameworkAdapter
 * @returns {{session: object, module: object, suites: object[], tests: object[]}}
 */
function getReportingEvents (payloads, requestedVersion, frameworkAdapter) {
  const settingsRequests = payloads.filter(({ url }) =>
    url.endsWith('/api/v2/libraries/tests/services/setting'))
  const advancedRequests = payloads.filter(({ url }) =>
    advancedRequestPaths.some(path => url.endsWith(path)))
  const cyclePayloads = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
  const events = cyclePayloads.flatMap(({ payload }) => payload.events)
  const sessions = events.filter(event => event.type === 'test_session_end').map(event => event.content)
  const modules = events.filter(event => event.type === 'test_module_end').map(event => event.content)
  const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
  const tests = events.filter(event => event.type === 'test').map(event => event.content)

  assert.strictEqual(settingsRequests.length, 1)
  assert.strictEqual(advancedRequests.length, 0, JSON.stringify(advancedRequests.map(({ url }) => url)))
  assert.strictEqual(sessions.length, 1, JSON.stringify({
    events: events.map(event => ({
      name: event.content?.name,
      spanType: event.content?.meta?.['span.type'],
      type: event.type,
    })),
    urls: payloads.map(({ url }) => url),
  }))
  assert.strictEqual(modules.length, 1)
  assert.strictEqual(sessions[0].meta[TEST_ITR_SKIPPING_ENABLED], 'false')
  assert.strictEqual(sessions[0].meta[TEST_CODE_COVERAGE_ENABLED], 'false')
  assert.strictEqual(sessions[0].meta[TEST_EARLY_FLAKE_ENABLED], undefined)
  assert.strictEqual(sessions[0].meta[TEST_MANAGEMENT_ENABLED], undefined)

  const metadata = cyclePayloads.flatMap(({ payload }) => payload.metadata || [])
  assert.ok(metadata.length > 0)
  for (const metadataEntry of metadata) {
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
  }

  for (const event of [sessions[0], modules[0], ...suites, ...tests]) {
    assert.strictEqual(event.meta[TEST_FRAMEWORK], 'webdriverio')
    assert.strictEqual(event.meta[TEST_MODULE], 'webdriverio')
    assert.strictEqual(event.meta[TEST_TYPE], 'browser')
    assert.ok(event.meta[TEST_FRAMEWORK_VERSION])
    if (requestedVersion !== 'latest') {
      assert.strictEqual(event.meta[TEST_FRAMEWORK_VERSION], requestedVersion)
    }
  }
  for (const event of [...suites, ...tests]) {
    assert.strictEqual(event.meta[TEST_FRAMEWORK_ADAPTER], frameworkAdapter)
  }
  assertEventHierarchy(sessions[0], modules[0], suites, tests)

  return {
    session: sessions[0],
    module: modules[0],
    suites,
    tests,
  }
}

for (const version of versions) {
  describe(`webdriverio@${version}`, function () {
    this.timeout(60_000)

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
    ], true, ['./integration-tests/webdriverio/fixtures/*'])

    before(async function () {
      cwd = sandboxCwd()
      webDriver = await startWebDriverServer()
    })

    after(async function () {
      await stopServer(webDriver?.server)
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
      receiver.setSettings(disabledSettings)
    })

    afterEach(async function () {
      childProcess?.kill()
      testOutput = ''
      await receiver.stop()
    })

    /**
     * Runs one WebdriverIO configuration scenario.
     *
     * @param {string} scenario
     * @param {number} expectedWebDriverSessions
     * @param {(events: ReturnType<typeof getReportingEvents>) => void} assertEvents
     * @param {number} [expectedExitCode]
     * @param {object} [options]
     * @param {string} [options.framework]
     * @returns {Promise<void>}
     */
    async function runScenario (scenario, expectedWebDriverSessions, assertEvents, expectedExitCode = 0, options = {}) {
      const { framework = 'mocha' } = options
      const initialWebDriverSessionCount = webDriver.getSessionCount()
      childProcess = exec('./node_modules/.bin/wdio run ./wdio.conf.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
          DD_TEST_SESSION_NAME: 'webdriverio-integration-test',
          WEBDRIVERIO_FRAMEWORK: framework,
          WEBDRIVERIO_SCENARIO: scenario,
          WEBDRIVER_PORT: String(webDriver.port),
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
        payloads => assertEvents(getReportingEvents(payloads, version, framework)),
        { hardTimeout: 45_000 }
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
      assert.doesNotMatch(testOutput, /dd:test-optimization:webdriverio:/)
      assert.doesNotMatch(testOutput, /\bundefined undefined undefined\b/)
      assert.strictEqual(
        webDriver.getSessionCount() - initialWebDriverSessionCount,
        expectedWebDriverSessions
      )
    }

    it('reports parallel workers as one session', async () => {
      await runScenario('parallel', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.deepStrictEqual(
          suites.map(suite => suite.meta[TEST_SUITE]).sort(),
          ['first.e2e.js', 'second.e2e.js']
        )
        assert.deepStrictEqual(
          tests.map(test => test.meta['test.webdriverio.worker']).sort(),
          ['first', 'second']
        )
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      })
    })

    it('reports parallel Jasmine workers as one session', async () => {
      await runScenario('parallel', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.deepStrictEqual(
          suites.map(suite => suite.meta[TEST_SUITE]).sort(),
          ['first.e2e.js', 'second.e2e.js']
        )
        assert.deepStrictEqual(
          tests.map(test => test.meta['test.webdriverio.worker']).sort(),
          ['first', 'second']
        )
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      }, 0, { framework: 'jasmine' })
    })

    it('reports Jasmine pass, fail, and skip statuses', async () => {
      await runScenario('jasmineStatuses', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'jasmine-statuses.e2e.js')
        assert.strictEqual(tests.length, 3)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass', 'skip'])
        assert.strictEqual(
          tests.find(test => test.meta[TEST_STATUS] === 'pass').meta['test.webdriverio.worker'],
          'jasmine'
        )
        assert.match(tests.find(test => test.meta[TEST_STATUS] === 'fail').meta['error.message'], /expected WebdriverIO/)
      }, 1, { framework: 'jasmine' })
    })

    it('reports failures before Jasmine loads', async () => {
      await runScenario('preFrameworkFailure', 0, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 0)
        assert.strictEqual(tests.length, 0)
      }, 1, { framework: 'jasmine' })
    })

    it('reports Jasmine specs that fail while loading', async () => {
      await runScenario('loadFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'load-fail.e2e.js')
        assert.strictEqual(tests.length, 0)
      }, 1, { framework: 'jasmine' })
    })

    it('reports sequential Jasmine workers as one session', async () => {
      await runScenario('serial', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      }, 0, { framework: 'jasmine' })
    })

    it('reports grouped Jasmine specs from one worker', async () => {
      await runScenario('grouped', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 1)
        assertOneTestPerSuiteExecution(suites, tests)
      }, 0, { framework: 'jasmine' })
    })

    it('reports an empty grouped Jasmine spec as skipped', async () => {
      await runScenario('groupedEmpty', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suites.length, 2)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['empty.e2e.js', 'skip'],
            ['first.e2e.js', 'pass'],
          ]
        )
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'pass')
      }, 0, { framework: 'jasmine' })
    })

    it('attributes a Jasmine hook-only failure to its grouped spec', async () => {
      await runScenario('hookFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['hook-fail.e2e.js', 'fail'],
          ]
        )
        assertOneTestPerSuiteExecution(suites, tests)
      }, 1, { framework: 'jasmine' })
    })

    it('reports a Jasmine afterAll failure on its suite', async () => {
      await runScenario('jasmineAfterAllFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'jasmine-after-all-fail.e2e.js')
        assert.match(suites[0].meta['error.message'], /expected WebdriverIO Jasmine afterAll failure/)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'pass')
      }, 0, { framework: 'jasmine' })
    })

    it('reports a Jasmine global afterAll failure on its suite', async () => {
      await runScenario('jasmineGlobalAfterAllFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['jasmine-global-after-all-fail.e2e.js', 'fail'],
          ]
        )
        const failedSuite = suites.find(suite => suite.meta[TEST_STATUS] === 'fail')
        assert.match(failedSuite.meta['error.message'], /expected WebdriverIO Jasmine global afterAll failure/)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['pass', 'pass'])
      }, 0, { framework: 'jasmine' })
    })

    it('starts Jasmine parent spans before tests when settings are delayed', async () => {
      receiver.setSettingsResponseDelay(1_000)

      await runScenario('jasmineDelayedSettings', 1, ({ session, module, suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        const test = tests[0]
        const testEnd = test.start + BigInt(test.duration)

        for (const parent of [session, module, suites[0]]) {
          assert.ok(parent.start <= test.start)
          assert.ok(parent.start + BigInt(parent.duration) >= testEnd)
        }
      }, 0, { framework: 'jasmine' })
    })

    it('keeps the Jasmine test span active in per-test hooks', async () => {
      await runScenario('jasmineHooks', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'pass')
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'pass')
        assert.strictEqual(tests[0].meta['test.webdriverio.jasmine.before-each'], 'active')
        assert.strictEqual(tests[0].meta['test.webdriverio.jasmine.after-each'], 'active')
      }, 0, { framework: 'jasmine' })
    })

    it('preserves tracer preload for Jasmine with runnerEnv.NODE_OPTIONS', async () => {
      await runScenario('runnerEnvNodeOptions', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.webdriverio.worker'], 'runner-env-node-options')
      }, 0, { framework: 'jasmine' })
    })

    it('reports Jasmine whole-spec retries in one session', async () => {
      await runScenario('specFileRetries', 2, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        assertOneTestPerSuiteExecution(suites, tests)

        const suiteStatusById = new Map(suites.map(suite => [
          suite.test_suite_id.toString(10),
          suite.meta[TEST_STATUS],
        ]))
        for (const test of tests) {
          assert.strictEqual(
            test.meta[TEST_STATUS],
            suiteStatusById.get(test.test_suite_id.toString(10))
          )
        }
      }, 0, { framework: 'jasmine' })
    })

    it('reports multiple Jasmine capabilities in one session', async () => {
      await runScenario('multipleCapabilities', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
        assertOneTestPerSuiteExecution(suites, tests)
      }, 0, { framework: 'jasmine' })
    })

    it('reports failures before Mocha loads', async () => {
      await runScenario('preFrameworkFailure', 0, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 0)
        assert.strictEqual(tests.length, 0)
      }, 1)
    })

    it('reports specs that fail while loading', async () => {
      await runScenario('loadFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'load-fail.e2e.js')
        assert.strictEqual(tests.length, 0)
      }, 1)
    })

    it('reports sequential workers as one session', async () => {
      await runScenario('serial', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      })
    })

    it('reports grouped specs from one worker', async () => {
      await runScenario('grouped', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 1)
      })
    })

    it('attributes a hook-only failure to its grouped spec', async () => {
      await runScenario('hookFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 1)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['hook-fail.e2e.js', 'fail'],
          ]
        )
      }, 1)
    })

    it('marks a spec filtered by mochaOpts.grep as skipped', async () => {
      await runScenario('grep', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 1)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['second.e2e.js', 'skip'],
          ]
        )
      })
    })

    it('reports mochaOpts.bail without leaving grouped suites open', async () => {
      await runScenario('bail', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 1)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['fail.e2e.js', 'fail'],
            ['second.e2e.js', 'skip'],
          ]
        )
      }, 1)
    })

    it('coordinates mochaOpts.delay with configuration loading', async () => {
      await runScenario('delay', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.webdriverio.worker'], 'delay')
      })
    })

    it('reports native Mocha retries', async () => {
      await runScenario('retries', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'pass')
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 1)
      })
    })

    it('preserves tracer preload with runnerEnv.NODE_OPTIONS', async () => {
      await runScenario('runnerEnvNodeOptions', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.webdriverio.worker'], 'runner-env-node-options')
      })
    })

    it('supports the Mocha TDD interface', async () => {
      await runScenario('tdd', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.webdriverio.worker'], 'tdd')
      })
    })

    it('reports whole-spec retries in one session', async () => {
      await runScenario('specFileRetries', 2, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        assertOneTestPerSuiteExecution(suites, tests)

        const suiteStatusById = new Map(suites.map(suite => [
          suite.test_suite_id.toString(10),
          suite.meta[TEST_STATUS],
        ]))
        for (const test of tests) {
          assert.strictEqual(
            test.meta[TEST_STATUS],
            suiteStatusById.get(test.test_suite_id.toString(10))
          )
        }
      })
    })

    it('reports multiple capabilities in one session', async () => {
      await runScenario('multipleCapabilities', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
        assertOneTestPerSuiteExecution(suites, tests)
      })
    })
  })
}
