'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisEvpProxyConfig,
  stopCiVisTestEnv,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
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

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
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

    this.timeout(80_000)
    let cwd, receiver, childProcess, webAppBaseUrl, webAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      this.timeout(180_000)
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)

      const webApp = await startWebAppServer()
      webAppBaseUrl = webApp.baseUrl
      webAppServer = webApp.server
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })

    after(async () => {
      await stopWebAppServer(webAppServer)
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

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
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
            }, { hardTimeout: 60000 })

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
              slow_test_retries: { '5s': 1 },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const specToRun = 'cypress/e2e/{flaky-test-retries,flaky-with-hooks.cy}.js'

          const envVars = getCiVisEvpProxyConfig(receiver.port)

          childProcess = exec(
            version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                CYPRESS_FLAKY_PASS_ATTEMPT: '1',
                DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
                SPEC_PATTERN: specToRun,
              },
            }
          )

          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)

                const sortByStart = arr =>
                  arr.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

                // Eventually-passing and always-failing tests are retried by ATR:
                // only the last attempt should have TEST_FINAL_STATUS
                for (const [suite, name, finalStatus] of [
                  ['cypress/e2e/flaky-test-retries.js', 'flaky test retry eventually passes', 'pass'],
                  ['cypress/e2e/flaky-test-retries.js', 'flaky test retry never passes', 'fail'],
                  ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks eventually passes', 'pass'],
                  ['cypress/e2e/flaky-with-hooks.cy.js', 'flaky with hooks never passes', 'fail'],
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
                      assert.strictEqual(test.meta[TEST_FINAL_STATUS], finalStatus)
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
              }, { hardTimeout: 60000 })

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        }
      )

      over10It('sets final_status tag on last retry (EFD active only)', async () => {
        const numRetriesEfd = 1

        // 'context passes' from spec.cy.js is NOT listed → new → EFD retries it
        // basic-pass.js is NOT listed → new → EFD retries a passing test with hooks
        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/spec.cy.js': ['other context fails'],
          },
        })
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': numRetriesEfd },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        const specToRun = 'cypress/e2e/{spec.cy,basic-pass}.js'

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
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

              // New test (no hooks): EFD retries once, only last has TEST_FINAL_STATUS
              const newTests = sortByStart(tests.filter(t =>
                t.meta[TEST_SUITE] === 'cypress/e2e/spec.cy.js' && t.meta[TEST_NAME] === 'context passes'
              ))
              assert.strictEqual(newTests.length, numRetriesEfd + 1)
              newTests.forEach((test, idx) => {
                if (idx < newTests.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in test.meta))
                } else {
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                }
              })

              // New tests with hooks: same — only last execution has TEST_FINAL_STATUS
              const newTestsWithHooks = sortByStart(tests.filter(t =>
                t.meta[TEST_SUITE] === 'cypress/e2e/basic-pass.js' &&
              t.meta[TEST_NAME] === 'basic pass suite can pass'
              ))
              assert.strictEqual(newTestsWithHooks.length, numRetriesEfd + 1)
              newTestsWithHooks.forEach((test, idx) => {
                if (idx < newTestsWithHooks.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in test.meta))
                } else {
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
                }
              })
            }, { hardTimeout: 60000 })

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

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '0',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
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
            }, { hardTimeout: 60000 })

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      over10It('sets final_status tag for test management states', async () => {
        receiver.setSettings({
          test_management: { enabled: true, attempt_to_fix_retries: 1 },
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
              'cypress/e2e/disable.js': {
                tests: {
                  'disable is disabled': { properties: { disabled: true } },
                },
              },
              'cypress/e2e/quarantine.js': {
                tests: {
                  'quarantine is quarantined': { properties: { quarantined: true } },
                },
              },
              'cypress/e2e/test-management-with-hooks.cy.js': {
                tests: {
                  'disabled with hooks is disabled': { properties: { disabled: true } },
                  'quarantined with hooks is quarantined': { properties: { quarantined: true } },
                  'quarantined with failing afterEach is quarantined': {
                    properties: { quarantined: true },
                  },
                },
              },
            },
          },
        })

        const specToRun = 'cypress/e2e/{attempt-to-fix,disable,quarantine,test-management-with-hooks.cy}.js'

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec "${specToRun}"`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
            },
          }
        )

        const eventsPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
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

              const quarantinedTest = tests.find(t => t.meta[TEST_NAME] === 'quarantine is quarantined')
              assert.ok(quarantinedTest)
              assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

              const quarantinedWithHooks = tests.find(t =>
                t.meta[TEST_NAME] === 'quarantined with hooks is quarantined'
              )
              assert.ok(quarantinedWithHooks)
              assert.strictEqual(quarantinedWithHooks.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedWithHooks.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedWithHooks.meta[TEST_FINAL_STATUS], 'skip')

              const passingWithHooks = tests.find(t =>
                t.meta[TEST_NAME] === 'quarantined with hooks passes normally'
              )
              assert.ok(passingWithHooks)
              assert.strictEqual(passingWithHooks.meta[TEST_STATUS], 'pass')
              assert.strictEqual(passingWithHooks.meta[TEST_FINAL_STATUS], 'pass')

              const quarantinedAfterEach = tests.find(t =>
                t.meta[TEST_NAME] === 'quarantined with failing afterEach is quarantined'
              )
              assert.ok(quarantinedAfterEach)
              assert.strictEqual(quarantinedAfterEach.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedAfterEach.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedAfterEach.meta[TEST_FINAL_STATUS], 'skip')

              // 1 original + 1 ATF retry = 2 executions; all fail (default behavior)
              const atfTests = tests.filter(t => t.meta[TEST_NAME] === 'attempt to fix is attempt to fix')
              assert.strictEqual(atfTests.length, 2)

              const sorted = atfTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
              sorted.forEach((test, idx) => {
                if (idx < sorted.length - 1) {
                  assert.ok(!(TEST_FINAL_STATUS in test.meta),
                  `TEST_FINAL_STATUS should not be set on intermediate ATF run ${idx}`)
                } else {
                  assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'fail')
                }
              })
            }, { hardTimeout: 60000 })

        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })
    })
  })
})
