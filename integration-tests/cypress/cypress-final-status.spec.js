'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_SUITE,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_NAME,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
const hookFile = 'dd-trace/loader-hook.mjs'
const NUM_RETRIES_EFD = 3

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      return NODE_MAJOR > 18 ? version === 'latest' : version === '14.5.4'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '10.2.0' || version === '14.5.4'
      }
      return version === '10.2.0' || version === '14.5.4' || version === 'latest'
    }
  }
  return false
}

const moduleTypes = [
  {
    type: 'commonJS',
    testCommand: function commandWithSuffic (version) {
      const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json --spec "cypress/e2e/*.cy.js"' : ''
      return `./node_modules/.bin/cypress run ${commandSuffix}`
    },
  },
  {
    type: 'esm',
    testCommand: `node --loader=${hookFile} ./cypress-esm-config.mjs`,
  },
].filter(moduleType => !process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === moduleType.type)

moduleTypes.forEach(({
  type,
  testCommand,
}) => {
  if (typeof testCommand === 'function') {
    testCommand = testCommand(version)
  }

  describe(`cypress@${version} ${type}`, function () {
    if (!shouldTestsRun(type)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping tests for cypress@${version} ${type} for dd-trace@${DD_MAJOR} node@${NODE_MAJOR}`)
      return
    }

    this.retries(2)
    this.timeout(80000)
    let cwd, receiver, childProcess, webAppPort, webAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    // typescript@5 is pinned because typescript@6 emits "use strict" on line 1 for
    // non-module files, shifting compiled line numbers and breaking source map resolution.
    // TODO: Update tests files accordingly and test with different TS versions
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript@5'], true)

    before(async function () {
      // Note: Cypress binary is already installed during useSandbox() via the postinstall script
      // when the cypress npm package is installed, so no explicit install is needed here
      cwd = sandboxCwd()
    })

    after(async () => {})

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()

      // Create a fresh web server for each test to avoid state issues
      webAppServer = createWebAppServer()
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        webAppServer.once('error', reject)
        webAppServer.listen(0, 'localhost', () => {
          webAppPort = webAppServer.address().port
          webAppServer.removeListener('error', reject)
          resolve()
        })
      }))
    })

    // Cypress child processes can sometimes hang or take longer to
    // terminate. This can cause `FakeCiVisIntake#stop` to be delayed
    // because there are pending connections.
    afterEach(async () => {
      if (childProcess && childProcess.pid) {
        try {
          childProcess.kill('SIGKILL')
        } catch (error) {
          // Process might already be dead - this is fine, ignore error
        }

        // Don't wait for exit - Cypress processes can hang indefinitely in uninterruptible I/O
        // The OS will clean up zombies, and fresh server per test prevents port conflicts
      }

      // Close web server before stopping receiver
      if (webAppServer) {
        await /** @type {Promise<void>} */ (new Promise((resolve) => {
          webAppServer.close((err) => {
            if (err) {
              // eslint-disable-next-line no-console
              console.error('Web server close error:', err)
            }
            resolve()
          })
        }))
      }

      // Add timeout to prevent hanging
      const stopPromise = receiver.stop()
      const timeoutPromise = new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error('Receiver stop timeout')), RECEIVER_STOP_TIMEOUT)
      )

      try {
        await Promise.race([stopPromise, timeoutPromise])
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Receiver stop timed out:', error.message)
      }

      // Small delay to allow OS to release ports
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    // These tests require Cypress >=10 features (defineConfig, setupNodeEvents)
    const over10It = (version !== '6.7.0') ? it : it.skip

    context('final status tag', function () {
      over10It('sets final_status tag to test status on regular tests without retry features', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          early_flake_detection: { enabled: false },
        })

        const specToRun = 'cypress/e2e/{spec.cy,skipped-test,hook-describe-error.cy}.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Every test's final status should match its actual status
            tests.forEach(test => {
              assert.strictEqual(
                test.meta[TEST_FINAL_STATUS],
                test.meta[TEST_STATUS],
                `Expected TEST_FINAL_STATUS to match TEST_STATUS for "${test.meta[TEST_NAME]}"`
              )
            })

            // Verify each status type explicitly
            const passingTest = tests.find(t => t.resource === 'cypress/e2e/spec.cy.js.context passes')
            assert.ok(passingTest, 'passing test not found')
            assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')

            const failingTest = tests.find(t => t.resource === 'cypress/e2e/spec.cy.js.other context fails')
            assert.ok(failingTest, 'failing test not found')
            assert.strictEqual(failingTest.meta[TEST_FINAL_STATUS], 'fail')

            const skippedTest = tests.find(t => t.resource === 'cypress/e2e/skipped-test.js.skipped skipped')
            assert.ok(skippedTest, 'skipped test not found')
            assert.strictEqual(skippedTest.meta[TEST_FINAL_STATUS], 'skip')

            // Hooks: after() failure retroactively marks the last test in the suite as failed
            const afterHookFailed = tests.find(t =>
              t.resource === 'cypress/e2e/hook-describe-error.cy.js.after will be marked as failed'
            )
            assert.ok(afterHookFailed, 'test with failing after() not found')
            assert.strictEqual(afterHookFailed.meta[TEST_FINAL_STATUS], 'fail')

            // Hooks: before() failure causes tests in the suite to be skipped
            const beforeHookSkipped = tests.find(t =>
              t.resource === 'cypress/e2e/hook-describe-error.cy.js.before will be skipped'
            )
            assert.ok(beforeHookSkipped, 'test skipped by before() not found')
            assert.strictEqual(beforeHookSkipped.meta[TEST_FINAL_STATUS], 'skip')
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It(
        'sets tag only on last ATR retry when EFD is enabled but not active and ATR is active',
        async () => {
          // All tests are known, so EFD will be enabled but not active for them
          receiver.setKnownTests({
            cypress: {
              'cypress/e2e/flaky-test-retries.js': [
                'flaky test retry eventually passes',
                'flaky test retry never passes',
                'flaky test retry always passes',
              ],
              'cypress/e2e/flaky-with-hooks.cy.js': [
                'flaky with hooks eventually passes',
                'flaky with hooks never passes',
                'flaky with hooks always passes',
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

          const specToRun = 'cypress/e2e/{flaky-test-retries,flaky-with-hooks.cy}.js'

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const sortByStart = arr =>
                arr.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

              // Eventually-passing and always-failing tests are retried by ATR:
              // only the last attempt should have TEST_FINAL_STATUS
              for (const [suite, name] of [
                ['cypress/e2e/flaky-test-retries.js', 'flaky test retry eventually passes'],
                ['cypress/e2e/flaky-test-retries.js', 'flaky test retry never passes'],
                ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks eventually passes'],
                ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks never passes'],
              ]) {
                const group = sortByStart(tests.filter(t =>
                  t.meta[TEST_SUITE] === suite && t.meta[TEST_NAME] === name
                ))
                assert.ok(group.length > 1, `Expected ATR retries for "${name}"`)
                group.forEach((test, idx) => {
                  if (idx < group.length - 1) {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta),
                      `TEST_FINAL_STATUS should not be set on intermediate run of "${name}"`)
                  } else {
                    assert.ok(TEST_FINAL_STATUS in test.meta,
                      `TEST_FINAL_STATUS should be set on last run of "${name}"`)
                  }
                })
              }

              // Always-passing tests have a single execution and get TEST_FINAL_STATUS immediately
              for (const [suite, name] of [
                ['cypress/e2e/flaky-test-retries.js', 'flaky test retry always passes'],
                ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks always passes'],
              ]) {
                const group = tests.filter(t =>
                  t.meta[TEST_SUITE] === suite && t.meta[TEST_NAME] === name
                )
                assert.strictEqual(group.length, 1, `Expected 1 execution for "${name}"`)
                assert.strictEqual(group[0].meta[TEST_FINAL_STATUS], 'pass')
              }
            }, 60000)

          const envVars = getCiVisEvpProxyConfig(receiver.port)

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: specToRun,
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        }
      )

      over10It('sets final_status tag on last retry (EFD active only)', async () => {
        // 'context passes' from spec.cy.js is NOT listed → new → EFD retries it
        // All tests in flaky-with-hooks.cy.js are NOT listed → new → EFD retries them
        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': ['other context fails'],
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

        const specToRun = 'cypress/e2e/{spec,flaky-with-hooks}.cy.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const sortByStart = arr =>
              arr.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            // Known test: single execution, TEST_FINAL_STATUS set immediately
            const knownTests = tests.filter(t =>
              t.meta[TEST_SUITE] === 'cypress/e2e/spec.cy.js' && t.meta[TEST_NAME] === 'other context fails'
            )
            assert.strictEqual(knownTests.length, 1)
            assert.ok(!(TEST_IS_NEW in knownTests[0].meta))
            assert.strictEqual(knownTests[0].meta[TEST_FINAL_STATUS], 'fail')

            // New test (no hooks): EFD retries NUM_RETRIES_EFD times, only last has TEST_FINAL_STATUS
            const newTests = sortByStart(tests.filter(t =>
              t.meta[TEST_SUITE] === 'cypress/e2e/spec.cy.js' && t.meta[TEST_NAME] === 'context passes'
            ))
            assert.strictEqual(newTests.length, NUM_RETRIES_EFD + 1)
            newTests.forEach((test, idx) => {
              if (idx < newTests.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
              }
            })

            // New tests with hooks: same — only last execution has TEST_FINAL_STATUS
            const newTestsWithHooks = sortByStart(tests.filter(t =>
              t.meta[TEST_SUITE] === 'cypress/e2e/flaky-with-hooks.cy.js' &&
              t.meta[TEST_NAME] === 'flaky with hooks always passes'
            ))
            assert.strictEqual(newTestsWithHooks.length, NUM_RETRIES_EFD + 1)
            newTestsWithHooks.forEach((test, idx) => {
              if (idx < newTestsWithHooks.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta))
              } else {
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
              }
            })
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('sets final_status tag on last retry (ATR active only)', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: { enabled: false },
        })

        const specToRun = 'cypress/e2e/{flaky-test-retries,flaky-with-hooks.cy}.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const sortByStart = arr =>
              arr.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            // Eventually-passing tests: final_status='pass' only on last ATR attempt
            for (const [suite, name] of [
              ['cypress/e2e/flaky-test-retries.js', 'flaky test retry eventually passes'],
              ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks eventually passes'],
            ]) {
              const group = sortByStart(tests.filter(t =>
                t.meta[TEST_SUITE] === suite && t.meta[TEST_NAME] === name
              ))
              group.forEach((test, idx) => {
                if (idx < group.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in test.meta))
                } else {
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                }
              })
            }

            // Always-failing tests: final_status='fail' only on last ATR attempt
            for (const [suite, name] of [
              ['cypress/e2e/flaky-test-retries.js', 'flaky test retry never passes'],
              ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks never passes'],
            ]) {
              const group = sortByStart(tests.filter(t =>
                t.meta[TEST_SUITE] === suite && t.meta[TEST_NAME] === name
              ))
              group.forEach((test, idx) => {
                if (idx < group.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in test.meta))
                } else {
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                }
              })
            }

            // Always-passing tests have a single execution — final_status='pass' immediately
            for (const [suite, name] of [
              ['cypress/e2e/flaky-test-retries.js', 'flaky test retry always passes'],
              ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks always passes'],
            ]) {
              const group = tests.filter(t =>
                t.meta[TEST_SUITE] === suite && t.meta[TEST_NAME] === name
              )
              assert.strictEqual(group.length, 1)
              assert.strictEqual(group[0].meta[TEST_FINAL_STATUS], 'pass')
            }
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('keeps failing final_status when ATR is enabled with zero retries', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: { enabled: false },
        })

        const specToRun = 'cypress/e2e/spec.cy.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 2, 'Expected no retries when flaky retry count is 0')

            const passingTest = tests.find(t => t.resource === 'cypress/e2e/spec.cy.js.context passes')
            assert.ok(passingTest, 'passing test not found')
            assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')

            const failingTest = tests.find(t => t.resource === 'cypress/e2e/spec.cy.js.other context fails')
            assert.ok(failingTest, 'failing test not found')
            assert.strictEqual(failingTest.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_IS_RETRY in failingTest.meta), 'failing test should not be marked as a retry')
            assert.strictEqual(failingTest.meta[TEST_FINAL_STATUS], 'fail')
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '0',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('sets final_status tag to skip for disabled tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTests({
          cypress: {
            suites: {
              'cypress/e2e/disable.js': {
                tests: {
                  'disable is disabled': { properties: { disabled: true } },
                },
              },
              'cypress/e2e/test-management-with-hooks.cy.js': {
                tests: {
                  'disabled with hooks is disabled': { properties: { disabled: true } },
                },
              },
            },
          },
        })

        const specToRun = 'cypress/e2e/{disable,test-management-with-hooks.cy}.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const disabledTest = tests.find(t => t.meta[TEST_NAME] === 'disable is disabled')
            assert.ok(disabledTest)
            assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')

            const disabledWithHooks = tests.find(t => t.meta[TEST_NAME] === 'disabled with hooks is disabled')
            assert.ok(disabledWithHooks)
            assert.strictEqual(disabledWithHooks.meta[TEST_STATUS], 'skip')
            assert.strictEqual(disabledWithHooks.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
            assert.strictEqual(disabledWithHooks.meta[TEST_FINAL_STATUS], 'skip')
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('sets final_status tag to skip for quarantined tests', async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTests({
          cypress: {
            suites: {
              'cypress/e2e/quarantine.js': {
                tests: {
                  'quarantine is quarantined': { properties: { quarantined: true } },
                },
              },
              'cypress/e2e/test-management-with-hooks.cy.js': {
                tests: {
                  'quarantined with hooks is quarantined': { properties: { quarantined: true } },
                },
              },
            },
          },
        })

        const specToRun = 'cypress/e2e/{quarantine,test-management-with-hooks.cy}.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Quarantined: runs but failure suppressed → TEST_STATUS='fail', TEST_FINAL_STATUS='skip'
            const quarantinedTest = tests.find(t => t.meta[TEST_NAME] === 'quarantine is quarantined')
            assert.ok(quarantinedTest)
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

            // Quarantined with hooks: same behavior
            const quarantinedWithHooks = tests.find(t =>
              t.meta[TEST_NAME] === 'quarantined with hooks is quarantined'
            )
            assert.ok(quarantinedWithHooks)
            assert.strictEqual(quarantinedWithHooks.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedWithHooks.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedWithHooks.meta[TEST_FINAL_STATUS], 'skip')

            // Non-quarantined test with hooks: final_status='pass'
            const passingWithHooks = tests.find(t =>
              t.meta[TEST_NAME] === 'quarantined with hooks passes normally'
            )
            assert.ok(passingWithHooks)
            assert.strictEqual(passingWithHooks.meta[TEST_STATUS], 'pass')
            assert.strictEqual(passingWithHooks.meta[TEST_FINAL_STATUS], 'pass')
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('sets final_status tag to skip for quarantined tests when hook throws', async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTests({
          cypress: {
            suites: {
              'cypress/e2e/test-management-with-hooks.cy.js': {
                tests: {
                  'quarantined with failing afterEach is quarantined': {
                    properties: { quarantined: true },
                  },
                },
              },
            },
          },
        })

        const specToRun = 'cypress/e2e/test-management-with-hooks.cy.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // Test body passes but afterEach throws; failure suppressed because test is quarantined
            const quarantinedTest = tests.find(t =>
              t.meta[TEST_NAME] === 'quarantined with failing afterEach is quarantined'
            )
            assert.ok(quarantinedTest)
            assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
            assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
            assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('sets final_status tag on last ATF retry', async () => {
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 3 },
        })
        receiver.setTestManagementTests({
          cypress: {
            suites: {
              'cypress/e2e/attempt-to-fix.js': {
                tests: {
                  'attempt to fix is attempt to fix': {
                    properties: { attempt_to_fix: true },
                  },
                },
              },
            },
          },
        })

        const specToRun = 'cypress/e2e/attempt-to-fix.js'

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            // 1 original + 3 ATF retries = 4 executions; all fail (default behavior)
            const atfTests = tests.filter(t => t.meta[TEST_NAME] === 'attempt to fix is attempt to fix')
            assert.strictEqual(atfTests.length, 4)

            const sorted = atfTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
            sorted.forEach((test, idx) => {
              if (idx < sorted.length - 1) {
                assert.ok(!(TEST_FINAL_STATUS in test.meta),
                  `TEST_FINAL_STATUS should not be set on intermediate ATF run ${idx}`)
              } else {
                // All attempts failed → hasPassedAllRetries=false → final_status='fail'
                assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
              }
            })
          }, 60000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })
  })
})
