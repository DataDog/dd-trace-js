'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  installPlaywrightChromium,
  getCiVisAgentlessConfig,
  assertObjectContains,
  createParallelIt,
} = require('../helpers')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
} = require('../../packages/dd-trace/src/plugins/util/test')

const { PLAYWRIGHT_VERSION } = process.env

const NUM_RETRIES_EFD = 3

const { getLatestPlaywrightSpecifier, oldest } = require('./versions')
const latest = getLatestPlaywrightSpecifier()
const versions = [oldest, latest]

const DEFAULT_IMPACTED_KNOWN_TESTS = {
  playwright: {
    'impacted-test.js':
      ['impacted test should be impacted', 'impacted test 2 should be impacted 2'],
    'unimpacted-test.js':
      ['unimpacted test should not be impacted'],
  },
}

const IMPACTED_QUARANTINE_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'impacted-test.js': {
        tests: {
          'impacted test should be impacted': {
            properties: {
              quarantined: true,
            },
          },
        },
      },
    },
  },
}

const IMPACTED_ATF_MANAGEMENT_TESTS = {
  playwright: {
    suites: {
      'impacted-test.js': {
        tests: {
          'impacted test should be impacted': {
            properties: {
              attempt_to_fix: true,
              quarantined: true,
            },
          },
        },
      },
    },
  },
}

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

    contextNewVersions('impacted tests', () => {
      // Add git setup before running impacted tests
      before(function () {
        execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
        fs.writeFileSync(
          path.join(cwd, 'ci-visibility/playwright-tests-impacted-tests/impacted-test.js'),
          `const { test, expect } = require('@playwright/test')

          test.beforeEach(async ({ page }) => {
            await page.goto(process.env.PW_BASE_URL)
          })

          test.describe('impacted test', () => {
            test('should be impacted', async ({ page }) => {
              await expect(page.locator('.hello-world')).toHaveText([
                'Hello Worldd'
              ])
            })
          })
          test.describe('impacted test 2', () => {
            test('should be impacted 2', async ({ page }) => {
              await expect(page.locator('.hello-world')).toHaveText([
                'Hello World'
              ])
            })
          })`
        )
        execSync('git add ci-visibility/playwright-tests-impacted-tests/impacted-test.js', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test.js" --no-verify', { cwd, stdio: 'ignore' })
      })

      after(function () {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
      })

      /**
       * @param {import('../ci-visibility-intake').FakeCiVisIntake} receiver
       * @param {object} options
       * @param {boolean} options.isModified
       * @param {boolean} [options.isEfd]
       * @param {boolean} [options.isEfdEnabled]
       * @param {boolean} [options.isNew]
       */
      const getTestAssertions = (receiver, { isModified, isEfd, isEfdEnabled = isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfdEnabled) {
              assertObjectContains(testSession.meta, {
                [TEST_EARLY_FLAKE_ENABLED]: 'true',
              })
            } else {
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assert.ok(resourceNames.includes('unimpacted-test.js.unimpacted test should not be impacted'))
            assert.ok(resourceNames.includes('impacted-test.js.impacted test should be impacted'))
            assert.ok(resourceNames.includes('impacted-test.js.impacted test 2 should be impacted 2'))

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/playwright-tests-impacted-tests/impacted-test.js')

            if (isEfd) {
              assert.strictEqual(impactedTests.length, (NUM_RETRIES_EFD + 1) * 2) // Retries + original test
            } else {
              assert.strictEqual(impactedTests.length, 2)
            }

            for (const impactedTest of impactedTests) {
              if (isModified) {
                assertObjectContains(impactedTest.meta, {
                  [TEST_IS_MODIFIED]: 'true',
                })
              } else {
                assert.ok(!(TEST_IS_MODIFIED in impactedTest.meta))
              }
              if (isNew) {
                assertObjectContains(impactedTest.meta, {
                  [TEST_IS_NEW]: 'true',
                })
              } else {
                assert.ok(!(TEST_IS_NEW in impactedTest.meta))
              }
              if (!isEfd) {
                assert.ok(!(TEST_EARLY_FLAKE_ABORT_REASON in impactedTest.meta))
              }
            }

            const unmodifiedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] ===
                'ci-visibility/playwright-tests-impacted-tests/unimpacted-test.js')

            assert.strictEqual(unmodifiedTests.length, 1)
            assert.ok(!(TEST_IS_MODIFIED in unmodifiedTests[0].meta))
            assert.ok(!(TEST_IS_NEW in unmodifiedTests[0].meta))
            assert.ok(!(TEST_IS_RETRY in unmodifiedTests[0].meta))

            if (isEfd) {
              const retriedTests = tests.filter(
                test => test.meta[TEST_IS_RETRY] === 'true'
              )
              assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD * 2)
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
              assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES_EFD * 2 : 0)
              assert.strictEqual(retriedTestsWithReason, NUM_RETRIES_EFD * 2)
            }
          }, 60000)

      /**
       * @param {import('../ci-visibility-intake').FakeCiVisIntake} receiver
       * @param {object} options
       * @param {boolean} options.isModified
       * @param {boolean} [options.isEfd]
       * @param {boolean} [options.isEfdEnabled]
       * @param {boolean} [options.isNew]
       * @param {Record<string, string>} [extraEnvVars]
       */
      const runImpactedTest = async (
        receiver,
        { isModified, isEfd = false, isEfdEnabled = isEfd, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions(receiver, {
          isModified,
          isEfd,
          isEfdEnabled,
          isNew,
        })
        let proc
        try {
          proc = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-impacted-tests',
                GITHUB_BASE_REF: '',
                ...extraEnvVars,
              },
            }
          )

          await Promise.all([once(proc, 'exit'), testAssertionsPromise])
        } finally {
          proc?.kill()
        }
      }

      context('test is not new', () => {
        it('should be detected as impacted', async (receiver) => {
          receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
          receiver.setSettings({ impacted_tests_enabled: true })
          await runImpactedTest(receiver, { isModified: true })
        })

        it('quarantines EFD-managed impacted tests without native retry duplication', async (receiver) => {
          receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
          receiver.setTestManagementTests(IMPACTED_QUARANTINE_MANAGEMENT_TESTS)
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
                '10s': NUM_RETRIES_EFD,
              },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
            test_management: { enabled: true },
          })

          let testOutput = ''
          let proc
          try {
            proc = exec(
              './node_modules/.bin/playwright test -c playwright.config.js impacted-test.js --retries=1',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-impacted-tests',
                  GITHUB_BASE_REF: '',
                },
              }
            )
            proc.stdout?.on('data', data => { testOutput += data.toString() })
            proc.stderr?.on('data', data => { testOutput += data.toString() })

            const eventsPromise = receiver
              .gatherPayloadsUntilChildExit(proc, ({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const testSession = events.find(event => event.type === 'test_session_end').content
                const quarantinedTests = tests.filter(
                  test => test.meta[TEST_MANAGEMENT_IS_QUARANTINED] === 'true'
                )

                assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
                assert.strictEqual(quarantinedTests.length, NUM_RETRIES_EFD + 1)
                assert.ok(quarantinedTests.every(test => test.meta[TEST_STATUS] === 'fail'))
                assert.ok(quarantinedTests.every(test => test.meta[TEST_IS_MODIFIED] === 'true'))
                assert.strictEqual(
                  quarantinedTests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length,
                  NUM_RETRIES_EFD
                )
              }, { hardTimeout: 60_000 })

            const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 0, testOutput)
          } finally {
            proc?.kill()
          }
        })

        it('does not run EFD for a modified attempt to fix test', async (receiver) => {
          const numAttemptToFixRetries = 2
          const testName = 'impacted test should be impacted'
          receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
          receiver.setTestManagementTests(IMPACTED_ATF_MANAGEMENT_TESTS)
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': NUM_RETRIES_EFD },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
            test_management: {
              enabled: true,
              attempt_to_fix_retries: numAttemptToFixRetries,
            },
          })

          let testOutput = ''
          let proc
          try {
            proc = exec(
              './node_modules/.bin/playwright test -c playwright.config.js impacted-test.js',
              {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  PW_BASE_URL: `http://localhost:${webAppPort}`,
                  TEST_DIR: './ci-visibility/playwright-tests-impacted-tests',
                  GITHUB_BASE_REF: '',
                },
              }
            )
            proc.stdout?.on('data', data => { testOutput += data.toString() })
            proc.stderr?.on('data', data => { testOutput += data.toString() })

            const eventsPromise = receiver
              .gatherPayloadsUntilChildExit(proc, ({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events
                  .filter(event => event.type === 'test')
                  .map(event => event.content)
                  .filter(test => test.meta[TEST_NAME] === testName)
                const testSession = events.find(event => event.type === 'test_session_end').content

                assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
                assert.strictEqual(tests.length, numAttemptToFixRetries + 1)
                assert.strictEqual(tests.filter(test => test.meta[TEST_IS_MODIFIED] === 'true').length, 1)
                for (const test of tests) {
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true')
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                  assert.notStrictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
                }

                const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.strictEqual(retries.length, numAttemptToFixRetries)
                assert.ok(retries.every(
                  test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf
                ))
              }, { hardTimeout: 60_000 })

            const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 1, testOutput)
          } finally {
            proc?.kill()
          }
        })

        it('does not manage impacted tests when the EFD retry budget is zero', async (receiver) => {
          receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': 0,
              },
            },
            known_tests_enabled: true,
          })
          await runImpactedTest(receiver, { isModified: true, isEfdEnabled: true })
        })

        it('does not mark or retry tests in unmodified files', async (receiver) => {
          receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
                '10s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          await runImpactedTest(
            receiver,
            { isModified: true, isEfd: true }
          )
        })

        it('should not be detected as impacted if disabled', async (receiver) => {
          receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
          receiver.setSettings({ impacted_tests_enabled: false })
          await runImpactedTest(receiver, { isModified: false })
        })

        it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
          async (receiver) => {
            receiver.setKnownTests(DEFAULT_IMPACTED_KNOWN_TESTS)
            receiver.setSettings({ impacted_tests_enabled: true })
            await runImpactedTest(
              receiver,
              { isModified: false },
              { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
            )
          })
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', async (receiver) => {
          receiver.setKnownTests({
            playwright: {
              'unimpacted-test.js':
                ['unimpacted test should not be impacted'],
            },
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
                '10s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          await runImpactedTest(
            receiver,
            { isModified: true, isEfd: true, isNew: true }
          )
        })
      })
    })
  })
})
