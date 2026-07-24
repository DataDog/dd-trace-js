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
  MOCHA_IS_PARALLEL,
  TEST_FRAMEWORK,
  TEST_STATUS,
  TEST_SUITE,
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
  early_flake_detection: { enabled: false },
  flaky_test_retries_enabled: false,
  known_tests_enabled: false,
  test_management: { enabled: false },
  impacted_tests_enabled: false,
  coverage_report_upload_enabled: false,
}

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

    it('reports multiple Mocha workers as one test session', async () => {
      childProcess = exec('./node_modules/.bin/wdio run ./wdio.conf.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
          DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
          DD_TEST_SESSION_NAME: 'webdriverio-integration-test',
          DD_TRACE_DISABLED_INSTRUMENTATIONS: 'url',
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
        payloads => {
          const settingsRequests = payloads.filter(({ url }) =>
            url.endsWith('/api/v2/libraries/tests/services/setting'))
          const events = payloads
            .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
            .flatMap(({ payload }) => payload.events)
          const sessions = events.filter(event => event.type === 'test_session_end').map(event => event.content)
          const modules = events.filter(event => event.type === 'test_module_end').map(event => event.content)
          const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)

          assert.strictEqual(settingsRequests.length, 1)
          assert.strictEqual(sessions.length, 1)
          assert.strictEqual(modules.length, 1)
          assert.strictEqual(suites.length, 2)
          assert.strictEqual(tests.length, 2)
          assert.strictEqual(sessions[0].meta[MOCHA_IS_PARALLEL], 'true')
          assert.strictEqual(sessions[0].meta[TEST_STATUS], 'pass')
          assert.deepStrictEqual(
            suites.map(suite => suite.meta[TEST_SUITE]).sort(),
            ['first.e2e.js', 'second.e2e.js']
          )
          assert.deepStrictEqual(
            tests.map(test => test.meta['test.webdriverio.worker']).sort(),
            ['first', 'second']
          )
          assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
          for (const test of tests) {
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[MOCHA_IS_PARALLEL], 'true')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          }
          assertEventHierarchy(sessions[0], modules[0], suites, tests)
        },
        { hardTimeout: 45_000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        payloadsPromise,
      ])

      assert.strictEqual(exitCode, 0, testOutput)
      assert.strictEqual(webDriver.getSessionCount(), 2)
    })
  })
}
