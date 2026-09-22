'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  installPlaywrightChromium,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  createParallelIt,
} = require('../helpers')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_NAME,
  TEST_IS_NEW,
  TEST_HAS_DYNAMIC_NAME,
  TEST_IS_RETRY,
  TEST_RETRY_REASON,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
} = require('../../packages/dd-trace/src/plugins/util/test')

const { PLAYWRIGHT_VERSION } = process.env

const { getLatestPlaywrightSpecifier, oldest } = require('./versions')
const latest = getLatestPlaywrightSpecifier()
const versions = [oldest, latest]

versions.forEach((version) => {
  if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
  if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

  // TODO: Remove this once we drop suppport for v5
  const contextNewVersions = satisfies(version, '>=1.38.0') || version === 'latest' ? context : context.skip

  describe(`playwright@${version}`, function () {
    const it = createParallelIt(global.it, { withReceiver: true })

    let cwd, webAppPort, webAppServer

    this.timeout(80000)

    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript'], true)

    before(function (done) {
      // Increase timeout for this hook specifically to account for slow chromium installation in CI
      this.timeout(120000)

      cwd = sandboxCwd()
      installPlaywrightChromium(cwd)

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

    context('flaky test retries', () => {
      it('can automatically retry flaky tests', async (receiver, run) => {
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

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('uses the cached dynamic budget instead of a conflicting flat count', async (receiver, run) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 0,
          early_flake_detection: { enabled: false },
        })

        const receiverPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          (payloads) => {
            const tests = payloads.flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2, 'one initial execution plus the first dynamic bucket')
            assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
            assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
            assert.strictEqual(tests[1].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          }, 30000)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-dynamic-atr',
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,2,3,4,5',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '5',
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      for (const outcome of ['fails', 'passes', 'times-out']) {
        it(`finalizes dynamic ATR when an expected failure ${outcome}`, async (receiver, run) => {
          receiver.setSettings({ flaky_test_retries_enabled: true, flaky_test_retries_count: 0 })
          const eventsPromise = receiver.gatherPayloadsMaxTimeout(
            ({ url }) => url === '/api/v2/citestcycle',
            payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              const status = outcome === 'passes' ? 'pass' : 'fail'
              assert.strictEqual(tests.length, outcome === 'fails' ? 1 : 3)
              assert.ok(tests.every(test => test.meta[TEST_STATUS] === status))
              assert.strictEqual(tests.at(-1).meta[TEST_FINAL_STATUS], status)
              assert.ok(tests.slice(0, -1).every(test => test.meta[TEST_FINAL_STATUS] === undefined))
              if (outcome === 'fails') {
                assert.strictEqual(tests[0].meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
              }
            }, 30000)
          const proc = run('./node_modules/.bin/playwright test -c playwright.config.js', {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-dynamic-atr',
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '2,2,2,2,2',
              PLAYWRIGHT_EXPECTED_FAILURE: outcome,
            },
          })
          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, outcome === 'fails' ? 0 : 1)
        })
      }

      const dynamicCases = [
        {
          name: 'elapsed duration',
          buckets: '3,1,1,1,1',
          attempts: 2,
          env: { PLAYWRIGHT_SLOW_INITIAL_ATTEMPT: '1' },
        },
        {
          name: 'serial retry offset',
          buckets: '1,1,1,1,1',
          attempts: 2,
          env: { PLAYWRIGHT_SERIAL_RETRY: '1' },
        },
      ]
      for (const scope of ['CLI', 'suite']) {
        for (const retries of [0, 1, 3]) {
          if (scope === 'CLI' && retries === 0) continue // Zero project retries enables ATR.
          dynamicCases.push({
            name: `${scope} retries=${retries}`,
            buckets: retries === 1 ? '3,3,3,3,3' : '1,1,1,1,1',
            attempts: retries + 1,
            args: scope === 'CLI' ? `--retries=${retries}` : '',
            env: scope === 'suite' ? { PLAYWRIGHT_SUITE_RETRIES: String(retries) } : {},
          })
        }
      }
      for (const scenario of dynamicCases) {
        it(`respects dynamic ATR ${scenario.name}`, async (receiver, run) => {
          receiver.setSettings({ flaky_test_retries_enabled: true })
          const eventsPromise = receiver.gatherPayloadsMaxTimeout(
            ({ url }) => url === '/api/v2/citestcycle',
            payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
                .filter(test => test.meta[TEST_NAME] === 'always fails' && test.meta[TEST_STATUS] !== 'skip')
              assert.strictEqual(tests.length, scenario.attempts)
              assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
              assert.strictEqual(tests.at(-1).meta[TEST_FINAL_STATUS], 'fail')
              if (scenario.attempts > 1) {
                assert.strictEqual(tests.at(-1).meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
              }
              assert.ok(tests.slice(0, -1).every(test => test.meta[TEST_FINAL_STATUS] === undefined))
            }, 30000)
          const proc = run(`./node_modules/.bin/playwright test -c playwright.config.js ${scenario.args || ''}`, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-dynamic-atr',
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: scenario.buckets,
              ...scenario.env,
            },
          })
          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, 1)
        })
      }

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', async (receiver, run) => {
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

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', async (receiver, run) => {
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

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async (receiver, run) => {
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

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })
    })

    contextNewVersions('dynamic name detection', () => {
      it('tags new tests with dynamic names and logs a warning', async (receiver, run) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 1 },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({ playwright: {} })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const uniqueTests = new Map(tests.map(test => [test.meta[TEST_NAME], test]))

            assert.strictEqual(uniqueTests.size, 8)
            for (const test of uniqueTests.values()) {
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              assert.strictEqual(test.meta[TEST_HAS_DYNAMIC_NAME], 'true')
            }
          }, 30000)

        const proc = run(
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
        proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })

        const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0, testOutput)
        assert.match(testOutput, /detected as new but their names contain dynamic data/)
      })
    })
  })
})
