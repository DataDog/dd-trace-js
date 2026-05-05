'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_NAME,
  TEST_IS_NEW,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR } = require('../../version')

const { PLAYWRIGHT_VERSION } = process.env

const NUM_RETRIES_EFD = 3

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

    this.retries(2)
    this.timeout(80000)

    // TODO: Update tests files accordingly and test with different TS versions
    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript@5'], true)

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
      childProcess?.kill()
      await receiver.stop()
    })

    contextNewVersions('final status tag', () => {
      it('sets final_status tag to test status on regular tests without retry features', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          early_flake_detection: { enabled: false },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // All playwright test fixtures use beforeEach for page.goto (hooks scenario covered)
            tests.forEach(test => {
              assert.strictEqual(
                test.meta[TEST_FINAL_STATUS],
                test.meta[TEST_STATUS],
                `Expected TEST_FINAL_STATUS to match TEST_STATUS for test "${test.meta[TEST_NAME]}"`
              )
            })
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('sets final_status tag to test status on last retry (ATR active only)', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: { enabled: false },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const eventuallyPassingTests = tests.filter(
              test => test.meta[TEST_NAME] === 'playwright should eventually pass after retrying'
            )
            // retry=0 fail, retry=1 fail, retry=2 pass → 3 runs total
            assert.strictEqual(eventuallyPassingTests.length, 3)
            eventuallyPassingTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
              .forEach((test, index) => {
                if (index < eventuallyPassingTests.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in test.meta),
                    `TEST_FINAL_STATUS should not be set on intermediate ATR run ${index}`)
                } else {
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                }
              })
          }, 30000)

        // --retries=2 is passed via CLI so test.info().retry increments correctly across all playwright versions.
        // dd-trace won't override it since its guard is `if (project.retries === 0)`.
        childProcess = exec(
          './node_modules/.bin/playwright test --retries=2 -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('sets final_status tag only on last EFD retry (EFD active only)', async () => {
        receiver.setKnownTests({
          playwright: {
            'landing-page-test.js': [
              'highest-level-describe  leading and trailing spaces    should work with skipped tests',
              'highest-level-describe  leading and trailing spaces    should work with fixme',
            ],
            'skipped-suite-test.js': [
              'should work with fixme root',
            ],
            'todo-list-page-test.js': [
              'playwright should work with failing tests',
              'should work with fixme root',
            ],
          },
        })
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': NUM_RETRIES_EFD },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Known tests: not retried, every execution is already the final one
            const knownTest = tests.find(
              test => test.meta[TEST_NAME] === 'playwright should work with failing tests'
            )
            assert.ok(knownTest)
            assert.ok(!(TEST_IS_NEW in knownTest.meta))
            assert.strictEqual(knownTest.meta[TEST_FINAL_STATUS], knownTest.meta[TEST_STATUS])

            // New tests: exactly one run has TEST_FINAL_STATUS and it must be the last to finish.
            // The main process marks the execution final based on arrival order of testEnd events,
            // so the run that completes last is always the one that gets the tag.
            const assertEfdFinalStatus = (testName, expectedFinalStatus) => {
              const group = tests.filter(t => t.meta[TEST_NAME] === testName)
              group.sort((a, b) => {
                const endA = BigInt(a.start) + BigInt(a.duration)
                const endB = BigInt(b.start) + BigInt(b.duration)
                return endA < endB ? -1 : endA > endB ? 1 : 0
              })
              group.forEach((t, index) => {
                if (index < group.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in t.meta),
                    `Run ${index} of "${testName}" should not have TEST_FINAL_STATUS`)
                } else {
                  assert.strictEqual(t.meta[TEST_FINAL_STATUS], expectedFinalStatus,
                    `Last run of "${testName}" should have TEST_FINAL_STATUS="${expectedFinalStatus}"`)
                }
              })
            }

            // should work with passing tests is new and passes consistently → final_status='pass'
            assertEfdFinalStatus(
              'highest-level-describe  leading and trailing spaces    should work with passing tests',
              'pass'
            )
            // should work with annotated tests is new and passes consistently → final_status='pass'
            assertEfdFinalStatus(
              'highest-level-describe  leading and trailing spaces    should work with annotated tests',
              'pass'
            )
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('sets final_status tag only on last ATR retry when EFD is enabled but not active and ATR is active',
        async () => {
          receiver.setKnownTests({
            playwright: {
              'automatic-retry-test.js': [
                'playwright should eventually pass after retrying',
              ],
            },
          })
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': NUM_RETRIES_EFD },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const receiverPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const eventuallyPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'playwright should eventually pass after retrying'
              )
              assert.ok(eventuallyPassingTests.length > 1)

              const finalRuns = eventuallyPassingTests.filter(t => TEST_FINAL_STATUS in t.meta)
              assert.strictEqual(finalRuns.length, 1,
                `Exactly one ATR run should have TEST_FINAL_STATUS, got ${finalRuns.length}`)
              assert.strictEqual(finalRuns[0].meta[TEST_FINAL_STATUS], finalRuns[0].meta[TEST_STATUS])
              assert.strictEqual(finalRuns[0].meta[TEST_STATUS], 'pass')

              const nonFinalRuns = eventuallyPassingTests.filter(t => !(TEST_FINAL_STATUS in t.meta))
              assert.strictEqual(nonFinalRuns.length, eventuallyPassingTests.length - 1,
                'All other ATR runs should not have TEST_FINAL_STATUS')
            }, 30000)

          // --retries=2 is passed via CLI so test.retries is correctly set at startup.
          // dd-trace won't override it since its guard is `if (project.retries === 0)`.
          childProcess = exec(
            './node_modules/.bin/playwright test --retries=2 -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])
        })

      it('sets final_status tag to skip for disabled tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'disabled-test.js': {
                tests: {
                  'disable should disable test': {
                    properties: { disabled: true },
                  },
                },
              },
            },
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const disabledTest = tests.find(test => test.meta[TEST_NAME] === 'disable should disable test')
            assert.ok(disabledTest, 'Expected to find the disabled test')
            assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')

            // Non-disabled tests with hooks (beforeEach) run normally
            const passingTest = tests.find(test => test.meta[TEST_NAME] === 'not disabled should not disable test')
            assert.ok(passingTest, 'Expected to find the passing non-disabled test')
            assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
            assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')
          }, 25000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js disabled-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-management',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('sets final_status tag to skip for quarantined tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTests({
          playwright: {
            suites: {
              'quarantine-test.js': {
                tests: {
                  'quarantine should quarantine failed test': {
                    properties: { quarantined: true },
                  },
                },
              },
              'quarantine-failing-after-each-test.js': {
                tests: {
                  'quarantine with failing afterEach should quarantine a test whose afterEach hook fails': {
                    properties: { quarantined: true },
                  },
                },
              },
            },
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Quarantined test still runs and fails, but final_status must be 'skip'
            const quarantinedTest = tests.find(
              test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test'
            )
            assert.ok(quarantinedTest, 'Expected to find the quarantined test')
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

            // Quarantined test whose afterEach throws: test body passes but hook causes failure — still skip
            const quarantinedAfterEachTest = tests.find(
              test => test.meta[TEST_NAME] ===
                'quarantine with failing afterEach should quarantine a test whose afterEach hook fails'
            )
            assert.ok(quarantinedAfterEachTest, 'Expected to find the quarantined test with failing afterEach')
            assert.strictEqual(quarantinedAfterEachTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedAfterEachTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedAfterEachTest.meta[TEST_FINAL_STATUS], 'skip')

            // Non-quarantined test with hooks runs and passes normally
            const passingTest = tests.find(
              test => test.meta[TEST_NAME] === 'not quarantined should pass normally'
            )
            assert.ok(passingTest, 'Expected to find the passing non-quarantined test')
            assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
            assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')
          }, 25000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js ' +
          'quarantine-test.js quarantine-failing-after-each-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-management',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('does not set final_status on intermediate skipped executions in serial mode', async () => {
        if (version === 'latest') return
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          early_flake_detection: { enabled: false },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const seriallySkippedTests = tests.filter(
              test => test.meta[TEST_NAME] === 'playwright serial should be skipped when previous test fails'
            )
            // cycle 0: skipped (A failed) — cycle 1: pass (A succeeded)
            assert.strictEqual(seriallySkippedTests.length, 2)

            const skippedExecution = seriallySkippedTests.find(t => t.meta[TEST_STATUS] === 'skip')
            assert.ok(skippedExecution, 'Expected a skipped execution')
            assert.ok(
              !(TEST_FINAL_STATUS in skippedExecution.meta),
              'Intermediate skipped execution should not have TEST_FINAL_STATUS'
            )

            const passExecution = seriallySkippedTests.find(t => t.meta[TEST_STATUS] === 'pass')
            assert.ok(passExecution, 'Expected a passing execution on the retry cycle')
            assert.strictEqual(passExecution.meta[TEST_FINAL_STATUS], 'pass')
          }, 30000)

        // --retries=1 is Playwright's native retry — no dd-trace retry features needed.
        // dd-trace won't override it since its guard is `if (project.retries === 0)`.
        childProcess = exec(
          './node_modules/.bin/playwright test --retries=1 -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry-serial',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it(
        'does not emit duplicate events for serial tests abandoned by fail-fast with retries enabled', async () => {
          if (version === 'latest') return
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            flaky_test_retries_enabled: false,
            early_flake_detection: { enabled: false },
          })

          const receiverPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // These serial tests never ran — abandoned when maxFailures cut the run after the
              // non-serial test exhausted its retries. Each must appear exactly once: the fallback
              // loop at the end of the run must not re-emit them as duplicates.
              const abandonedTests = tests.filter(t =>
                t.meta[TEST_NAME] === 'playwright serial should fail on first attempt' ||
              t.meta[TEST_NAME] === 'playwright serial should be skipped when previous test fails'
              )
              assert.strictEqual(abandonedTests.length, 2)
              abandonedTests.forEach(t => assert.strictEqual(t.meta[TEST_STATUS], 'skip'))

              // Suite finalization must not be blocked by the abandoned tests staying in remainingTestsByFile
              const suiteEvents = events.filter(event => event.type === 'test_suite_end')
              assert.ok(suiteEvents.length > 0, 'Expected test_suite_end — suite must be finalized')
            }, 30000)

          // --retries=1: `should eventually pass after retrying` needs retry>=2 to pass, so it exhausts
          // both attempts and fails. MAX_FAILURES=1 then cuts the run, abandoning the serial suite.
          // PLAYWRIGHT_WORKERS=1 ensures the non-serial test always runs (and fails) before the serial suite.
          childProcess = exec(
            './node_modules/.bin/playwright test --retries=1 -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-automatic-retry-serial',
                MAX_FAILURES: '1',
                PLAYWRIGHT_WORKERS: '1',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])
        })
    })
  })
})
