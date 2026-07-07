'use strict'

const assert = require('node:assert/strict')
const { exec, execSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const semver = require('semver')
const {
  sandboxCwd,
  useSandbox,
  getCiVisEvpProxyConfig,
  assertObjectContains,
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
  TEST_SOURCE_FILE,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_SESSION_NAME,
  TEST_RETRY_REASON,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'
const NUM_RETRIES_EFD = 3
const over12It = (version === 'latest' || semver.gte(version, '12.0.0')) ? it : it.skip

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
  if (DD_MAJOR >= 6) {
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
                DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
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
                let foundIntermediateRetry = false

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
                    const isFirstAttempt = idx === 0
                    const isLastAttempt = idx === group.length - 1
                    if (isFirstAttempt) {
                      assert.ok(!(TEST_IS_RETRY in test.meta), `First run of "${name}" should not be a retry`)
                    } else {
                      assert.strictEqual(test.meta[TEST_IS_RETRY], 'true')
                    }
                    if (!isLastAttempt) {
                      if (!isFirstAttempt) {
                        foundIntermediateRetry = true
                      }
                      assert.ok(
                        !(TEST_FINAL_STATUS in test.meta),
                        `TEST_FINAL_STATUS should not be set on intermediate run of "${name}"`
                      )
                      return
                    }
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], finalStatus)
                  })
                }
                assert.ok(foundIntermediateRetry, 'Expected at least one intermediate ATR retry')

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

    context('libraries capabilities', () => {
      it('adds capabilities to tests', async () => {
        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              DD_TEST_SESSION_NAME: 'my-test-session-name',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const metadataDicts = payloads
                .filter(({ payload }) => payload.metadata?.test)
                .flatMap(({ payload }) => payload.metadata)

              assert.ok(metadataDicts.length > 0, `Expected ${metadataDicts.length} > 0`)
              metadataDicts.forEach(metadata => {
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
                // capabilities logic does not overwrite test session name
                assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session-name')
              })
            }, { hardTimeout: 25000 })

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })
    })

    context('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/impacted-test.js': ['impacted test is impacted test'],
          },
        })
      })

      // Add git setup before running impacted tests
      before(function () {
        execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
        fs.writeFileSync(
          path.join(cwd, 'cypress/e2e/impacted-test.js'),
          `/* eslint-disable */
          describe('impacted test', () => {
            it('is impacted test', () => {
              cy.visit('/')
                .get('.hello-world')
                .should('have.text', 'Hello Worldd')
            })
          })`
        )
        execSync('git add cypress/e2e/impacted-test.js', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test.js"', { cwd, stdio: 'ignore' })

        // Modify impacted-test-order.js to make it "impacted"
        const currentContent = fs.readFileSync(path.join(cwd, 'cypress/e2e/impacted-test-order.js'), 'utf-8')
        fs.writeFileSync(
          path.join(cwd, 'cypress/e2e/impacted-test-order.js'),
          currentContent + '\n// modified'
        )
        execSync('git add cypress/e2e/impacted-test-order.js', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test-order.js"', { cwd, stdio: 'ignore' })
      })

      after(function () {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
      })

      const getTestAssertions = ({ isModified, isEfd, isNew }, childProcess) =>
        receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isEfd) {
                assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
              } else {
                assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
              }

              const resourceNames = tests.map(span => span.resource)

              assertObjectContains(resourceNames,
                [
                  'cypress/e2e/impacted-test.js.impacted test is impacted test',
                ]
              )

              const impactedTests = tests.filter(test =>
                test.meta[TEST_SOURCE_FILE] === 'cypress/e2e/impacted-test.js' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test')

              if (isEfd) {
                assert.strictEqual(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
              } else {
                assert.strictEqual(impactedTests.length, 1)
              }

              for (const impactedTest of impactedTests) {
                if (isModified) {
                  assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
                } else {
                  assert.ok(!(TEST_IS_MODIFIED in impactedTest.meta))
                }
                if (isNew) {
                  assert.strictEqual(impactedTest.meta[TEST_IS_NEW], 'true')
                } else {
                  assert.ok(!(TEST_IS_NEW in impactedTest.meta))
                }
              }

              if (isEfd) {
                const retriedTests = tests.filter(
                  test => test.meta[TEST_IS_RETRY] === 'true' &&
                test.meta[TEST_NAME] === 'impacted test is impacted test'
                )
                assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
                let retriedTestNew = 0
                let retriedTestsWithReason = 0
                retriedTests.forEach(test => {
                  if (test.meta[TEST_IS_NEW] === 'true') {
                    retriedTestNew++
                  }
                  if (test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd) {
                    retriedTestsWithReason++
                  }
                })
                assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
                assert.strictEqual(retriedTestsWithReason, NUM_RETRIES_EFD)
              }
            }, 25000)

      const runImpactedTest = async (
        { isModified, isEfd = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
              ...extraEnvVars,
            },
          }
        )

        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew }, childProcess)

        await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise,
        ])
      }

      context('test is not new', () => {
        it('should be detected as impacted', async () => {
          receiver.setSettings({ impacted_tests_enabled: true })

          await runImpactedTest({ isModified: true })
        })

        it('should not be detected as impacted if disabled', async () => {
          receiver.setSettings({ impacted_tests_enabled: false })

          await runImpactedTest({ isModified: false })
        })

        it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
          async () => {
            receiver.setSettings({ impacted_tests_enabled: true })

            await runImpactedTest(
              { isModified: false },
              { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
            )
          })
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', async () => {
          receiver.setKnownTests({
            cypress: {},
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          await runImpactedTest(
            { isModified: true, isEfd: true, isNew: true }
          )
        })
      })

      over12It('does not retry impacted tests when testIsolation is false', async () => {
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              assertObjectContains(testSession.meta, {
                [TEST_EARLY_FLAKE_ENABLED]: 'true',
              })

              const impactedTests = tests.filter(test =>
                test.meta[TEST_SOURCE_FILE] === 'cypress/e2e/impacted-test.js' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test')

              // Should only have 1 test, no retries when testIsolation is false
              assert.equal(impactedTests.length, 1)

              for (const impactedTest of impactedTests) {
                assertObjectContains(impactedTest.meta, {
                  [TEST_IS_MODIFIED]: 'true',
                })
              }

              // No retries should occur when testIsolation is false
              const retriedTests = tests.filter(
                test => test.meta[TEST_IS_RETRY] === 'true' &&
              test.meta[TEST_NAME] === 'impacted test is impacted test'
              )
              assert.equal(retriedTests.length, 0)
            }, { hardTimeout: 25000 })

        await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])
      })

      it('retries impacted tests in the correct order (right after original test)', async () => {
        let testOutput = ''
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          cypress: {
            'cypress/e2e/impacted-test-order.js': [
              'impacted test order first test',
              'impacted test order second test',
            ],
          },
        })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test-order.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // All tests in the file are new and modified, so they should all be retried
              // 2 tests * (1 original + 2 retries) = 6 tests total
              assert.equal(tests.length, 6)

              // Extract test execution order with full details
              const testExecutionOrder = tests.map(test => ({
                name: test.meta[TEST_NAME],
                isRetry: test.meta[TEST_IS_RETRY] === 'true',
                isModified: test.meta[TEST_IS_MODIFIED] === 'true',
              }))

              // All should be marked as modified
              testExecutionOrder.forEach(test => {
                assert.equal(test.isModified, true)
              })

              // Expected order:
              // 1. "first test" (original)
              // 2. "first test" (retry 1)
              // 3. "first test" (retry 2)
              // 4. "second test" (original)
              // 5. "second test" (retry 1)
              // 6. "second test" (retry 2)

              assertObjectContains(testExecutionOrder, [
                { name: 'impacted test order first test', isRetry: false },
                { name: 'impacted test order first test', isRetry: true },
                { name: 'impacted test order first test', isRetry: true },
                { name: 'impacted test order second test', isRetry: false },
                { name: 'impacted test order second test', isRetry: true },
                { name: 'impacted test order second test', isRetry: true },
              ])

              const testSession = events.find(event => event.type === 'test_session_end').content
              assertObjectContains(testSession.meta, {
                [TEST_EARLY_FLAKE_ENABLED]: 'true',
              })
            }, { hardTimeout: 25000 })

        childProcess.stdout?.on('data', (data) => {
          testOutput += data.toString()
          process.stdout.write(data)
        })
        childProcess.stderr?.on('data', (data) => {
          testOutput += data.toString()
          process.stderr.write(data)
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          receiverPromise,
        ])

        assert.match(testOutput, /Retrying "impacted test order first test" to detect flakes because it is modified/)
        assert.match(testOutput, /Retrying "impacted test order second test" to detect flakes because it is modified/)
      })
    })
  })
})
