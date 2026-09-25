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
  TEST_BROWSER_NAME,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
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
    // Worker trace finalization and these fixtures require the Playwright 1.38+ integration.
    const modernRetryTest = satisfies(version, '>=1.38.0') || version === 'latest' ? it : global.it.skip

    let cwd, webAppPort, webAppServer

    this.timeout(80000)
    // Exact event counts are meaningful only after Playwright finishes, within the suite's execution budget.
    const collectionOptions = { hardTimeout: this.timeout() }

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
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
          }, collectionOptions)

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

        const receiverPromise = receiver.gatherPayloadsUntilChildExit(
          proc, ({ url }) => url === '/api/v2/citestcycle',
          (payloads) => {
            const tests = payloads.flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2, 'one initial execution plus the first dynamic bucket')
            assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
            assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
            assert.strictEqual(tests[1].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          }, collectionOptions)

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      for (const outcome of ['fails', 'passes', 'times-out']) {
        it(`finalizes dynamic ATR when an expected failure ${outcome}`, async (receiver, run) => {
          receiver.setSettings({ flaky_test_retries_enabled: true, flaky_test_retries_count: 0 })
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
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(
            proc, ({ url }) => url === '/api/v2/citestcycle',
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
            }, collectionOptions)
          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, outcome === 'fails' ? 0 : 1)
        })
      }

      for (const retryMode of ['disabled', 'suite-zero', 'flat-zero']) {
        modernRetryTest(`exports serial tests before session end with ${retryMode} retries`, async (receiver, run) => {
          receiver.setSettings({ flaky_test_retries_enabled: retryMode !== 'disabled' })
          receiver.setInfoResponse({ traceReceived: false })
          const traceReceived = receiver.payloadReceived(({ url, payload }) =>
            url === '/api/v2/citestcycle' && payload.events.some(event =>
              event.type === 'test' && event.content.meta[TEST_NAME] === 'exports completed test'),
          30000).then(() => receiver.setInfoResponse({ traceReceived: true }))
          const proc = run('./node_modules/.bin/playwright test -c playwright.config.js', {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-serial-no-retries',
              TRACE_RECEIVED_URL: `http://localhost:${receiver.port}/info`,
              PLAYWRIGHT_SUITE_RETRIES: retryMode === 'suite-zero' ? '0' : '',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: retryMode === 'flat-zero' ? '0' : '1',
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: String(retryMode !== 'flat-zero'),
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,1,1,1,1',
            },
          })
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(
            proc, ({ url }) => url === '/api/v2/citestcycle', payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 2)
              assert.ok(tests.every(test => test.meta[TEST_FINAL_STATUS] === 'pass'))
            }, collectionOptions)
          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise, traceReceived])
          assert.strictEqual(exitCode, 0)
        })
      }

      for (const dynamic of [false, true]) {
        for (const maxFailures of [0, 1, 2]) {
          const outcome = maxFailures ? 'canceled' : 'completed'
          it(`finalizes non-serial ${outcome} retries (dynamic=${dynamic}, maxFailures=${maxFailures})`,
            async (receiver, run) => {
              receiver.setSettings({ flaky_test_retries_enabled: dynamic })
              const args = dynamic ? '' : '--retries=3'
              const proc = run(
                `./node_modules/.bin/playwright test -c playwright.config.js --max-failures=${maxFailures} ${args}`, {
                  cwd,
                  env: {
                    ...getCiVisAgentlessConfig(receiver.port),
                    TEST_DIR: './ci-visibility/playwright-dynamic-atr',
                    DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
                    DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '3,3,3,3,3',
                  },
                })
              const eventsPromise = receiver.gatherPayloadsUntilChildExit(
                proc, ({ url }) => url === '/api/v2/citestcycle', payloads => {
                  const tests = payloads.flatMap(({ payload }) => payload.events)
                    .filter(event => event.type === 'test').map(event => event.content)
                  assert.strictEqual(tests.length, version === oldest && maxFailures ? maxFailures : 4)
                  assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'fail'))
                  assert.ok(tests.every(test => test.meta['_dd.playwright.retry_test_id'] === undefined))
                  assert.ok(tests.every(test => test.meta['_dd.playwright.defer_final_status'] === undefined))
                  assert.strictEqual(tests.at(-1).meta[TEST_FINAL_STATUS], 'fail')
                  assert.ok(tests.slice(0, -1).every(test => test.meta[TEST_FINAL_STATUS] === undefined))
                }, collectionOptions)
              const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
              assert.strictEqual(exitCode, 1)
            })
        }
      }

      for (const [scenario, counts, finalStatuses, args] of [
        ['different-budgets', [2, 4], ['pass', 'fail'], ''],
        ['earlier-fails-on-retry', [2, 3], ['fail', 'fail'], ''],
        ['later-recovers', [2, 2], ['pass', 'pass'], ''],
        ['all-pass', [1, 1], ['pass', 'pass'], ''],
        // Playwright 1.38 counts failed attempts before retries when enforcing maxFailures.
        ['fail-fast', version === oldest ? [1, 1] : [2, 4], ['pass', 'fail'], '--max-failures=1'],
        ['native-retries', [2, 2], ['pass', 'fail'], '--retries=1'],
        ['two-projects', [2, 4], ['pass', 'fail'], ''],
        ['screenshots', [2, 4], ['pass', 'fail'], ''],
      ]) {
        modernRetryTest(`finalizes serial ATR executions once for ${scenario}`, async (receiver, run) => {
          if (scenario === 'screenshots') receiver.setMediaResponseDelay(1500)
          receiver.setSettings({ flaky_test_retries_enabled: true })
          let output = ''
          const proc = run(`./node_modules/.bin/playwright test -c playwright.config.js ${args}`, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-dynamic-atr-serial',
              DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,3,3,3,3',
              PLAYWRIGHT_SERIAL_SCENARIO: scenario,
              PLAYWRIGHT_OUTPUT_DIR: `./test-results-serial-atr-${scenario}`,
              ADD_DUPLICATE_PLAYWRIGHT_PROJECT: scenario === 'two-projects' ? '1' : '',
              DD_TEST_FAILURE_SCREENSHOTS_ENABLED: String(scenario === 'screenshots'),
              PLAYWRIGHT_FAILURE_SCREENSHOT_MODE: scenario === 'screenshots' ? 'only-on-failure' : 'off',
            },
          })
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(
            proc, ({ url }) => url === '/api/v2/citestcycle',
            payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              const projects = scenario === 'two-projects' ? ['chromium', 'second-chromium'] : ['chromium']
              assert.ok(tests.every(test => test.meta['_dd.playwright.retry_test_id'] === undefined))
              assert.ok(tests.every(test => test.meta['_dd.playwright.defer_final_status'] === undefined))
              for (const project of projects) {
                for (const [index, name] of ['earlier short test', 'later slow test'].entries()) {
                  const attempts = tests.filter(test => test.meta[TEST_NAME] === `different budgets ${name}` &&
                    test.meta[TEST_BROWSER_NAME] === project)
                  const executions = attempts.filter(test => test.meta[TEST_STATUS] !== 'skip')
                  assert.strictEqual(executions.length, counts[index], name)
                  const finalExecutions = attempts.filter(test => test.meta[TEST_FINAL_STATUS] !== undefined)
                  assert.strictEqual(finalExecutions.length, 1, name)
                  assert.strictEqual(executions.at(-1).meta[TEST_FINAL_STATUS], finalStatuses[index], name)
                  if (scenario === 'screenshots' && index === 1) {
                    assert.ok(executions.every(test => test.meta[TEST_FAILURE_SCREENSHOT_UPLOADED] === 'true'))
                  }
                }
              }
            }, collectionOptions).catch(error => {
            error.message += `\nPlaywright output:\n${output}`
            throw error
          })
          proc.stdout?.on('data', chunk => { output += chunk.toString() })
          proc.stderr?.on('data', chunk => { output += chunk.toString() })
          const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
          // Playwright 1.38 classifies a failure with a skipped retry as flaky, so this run succeeds.
          const isOldSerialFlaky = version === oldest && scenario === 'earlier-fails-on-retry'
          assert.strictEqual(exitCode, finalStatuses.includes('fail') && !isOldSerialFlaky ? 1 : 0, output)
        })
      }

      for (const name of ['', 'same-name']) {
        for (const nativeFirst of [false, true]) {
          const label = `${name || 'unnamed'}, nativeFirst=${nativeFirst}`
          it(`isolates dynamic ATR for colliding project names (${label})`, async (receiver, run) => {
            receiver.setSettings({ flaky_test_retries_enabled: true })
            const proc = run(
              './node_modules/.bin/playwright test -c ci-visibility/playwright-dynamic-atr-projects.config.js', {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
                  DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,1,1,1,1',
                  PLAYWRIGHT_PROJECT_NAME: name,
                  PLAYWRIGHT_NATIVE_PROJECT_FIRST: nativeFirst ? '1' : '',
                },
              })
            const eventsPromise = receiver.gatherPayloadsUntilChildExit(
              proc, ({ url }) => url === '/api/v2/citestcycle', payloads => {
                const tests = payloads.flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 6)
                for (const [source, count] of [['automatic', 2], ['native', 4]]) {
                  const attempts = tests.filter(test => test.meta['test.retry_source'] === source)
                  assert.strictEqual(attempts.length, count, source)
                  assert.ok(attempts.every(test => test.meta[TEST_STATUS] === 'fail'))
                  assert.ok(attempts.slice(0, -1).every(test => test.meta[TEST_FINAL_STATUS] === undefined))
                  assert.strictEqual(attempts.at(-1).meta[TEST_FINAL_STATUS], 'fail')
                  assert.strictEqual(attempts.at(-1).meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
                }
              }, collectionOptions)
            const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 1)
          })
        }
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
          requiresModernPlaywright: true,
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
            requiresModernPlaywright: scope === 'suite',
            buckets: retries === 1 ? '3,3,3,3,3' : '1,1,1,1,1',
            attempts: retries + 1,
            args: scope === 'CLI' ? `--retries=${retries}` : '',
            env: scope === 'suite' ? { PLAYWRIGHT_SUITE_RETRIES: String(retries) } : {},
          })
        }
      }
      for (const scenario of dynamicCases) {
        const runTest = scenario.requiresModernPlaywright ? modernRetryTest : it
        runTest(`respects dynamic ATR ${scenario.name}`, async (receiver, run) => {
          receiver.setSettings({ flaky_test_retries_enabled: true })
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
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(
            proc, ({ url }) => url === '/api/v2/citestcycle',
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
            }, collectionOptions)
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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests.filter(
              (test) => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 0)
          }, collectionOptions)

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 2)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 2)

            const failedRetryTests = failedTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )
            assert.strictEqual(failedRetryTests.length, 1)
          }, collectionOptions)

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

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(proc, ({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 2, 'initial + 1 ATR retry, both fail')
            const lastFailed = failedTests[failedTests.length - 1]
            assert.strictEqual(lastFailed.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
            assert.strictEqual(lastFailed.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          }, collectionOptions)

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

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(proc, ({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const uniqueTests = new Map(tests.map(test => [test.meta[TEST_NAME], test]))

            assert.strictEqual(uniqueTests.size, 8)
            for (const test of uniqueTests.values()) {
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              assert.strictEqual(test.meta[TEST_HAS_DYNAMIC_NAME], 'true')
            }
          }, collectionOptions)

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
