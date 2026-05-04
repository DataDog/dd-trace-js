'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_IS_RETRY,
  TEST_RETRY_REASON,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR } = require('../../version')

const { PLAYWRIGHT_VERSION } = process.env

const latest = 'latest'
const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const versions = [oldest, latest]

versions.forEach((version) => {
  if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
  if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

  // TODO: Remove this once we drop suppport for v5
  const contextNewVersions = (...args) => {
    if (satisfies(version, '>=1.38.0') || version === 'latest') {
      context(...args)
    }
  }

  describe(`playwright@${version}`, function () {
    let cwd, receiver, childProcess, webAppPort, webAppServer

    this.timeout(80000)

    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript'], true)

    before(function (done) {
      // Increase timeout for this hook specifically to account for slow chromium installation in CI
      this.timeout(120000)

      cwd = sandboxCwd()
      const { NODE_OPTIONS, ...restOfEnv } = process.env
      // Install chromium (configured in integration-tests/playwright.config.js)
      // *Be advised*: this means that we'll only be using chromium for this test suite
      // This will use cached browsers if available, otherwise download
      execSync('npx playwright install chromium', { cwd, env: restOfEnv, stdio: 'inherit' })

      // Create fresh server instance to avoid issues with retries
      webAppServer = createWebAppServer()

      webAppServer.listen(0, (err) => {
        if (err) {
          return done(err)
        }
        webAppPort = webAppServer.address().port
        done()
      })
    })

    after(async () => {
      await new Promise(resolve => webAppServer.close(resolve))
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    context('flaky test retries', () => {
      it('can automatically retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 3)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 2)

            const failedRetryTests = failedTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )
            assert.strictEqual(failedRetryTests.length, 1) // the first one is not a retry

            const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
            assert.strictEqual(passedTests.length, 1)
            assert.strictEqual(passedTests[0].meta[TEST_IS_RETRY], 'true')
            assert.strictEqual(passedTests[0].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests.filter(
              (test) => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 0)
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 2)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 2)

            const failedRetryTests = failedTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )
            assert.strictEqual(failedRetryTests.length, 1)
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })

      it('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 1,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 2, 'initial + 1 ATR retry, both fail')
            const lastFailed = failedTests[failedTests.length - 1]
            assert.strictEqual(lastFailed.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
            assert.strictEqual(lastFailed.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            },
          }
        )

        await Promise.all([once(childProcess, 'exit'), receiverPromise])
      })

      contextNewVersions('dynamic name detection', () => {
        it('tags new tests with dynamic names and logs a warning', async () => {
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': 1 },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })
          receiver.setKnownTests({ playwright: {} })

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisEvpProxyConfig(receiver.port),
                TEST_DIR: './ci-visibility/playwright-tests-dynamic',
              },
            }
          )

          let testOutput = ''
          childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
          childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

          await once(childProcess, 'exit')

          assert.match(testOutput, /detected as new but their names contain dynamic data/)
        })
      })
    })
  })
})
