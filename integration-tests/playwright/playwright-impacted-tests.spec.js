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
  getCiVisAgentlessConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
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

    contextNewVersions('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          playwright: {
            'ci-visibility/playwright-tests-impacted-tests/impacted-test.js':
              ['impacted test should be impacted', 'impacted test 2 should be impacted 2'],
          },
        })
      })

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

      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfd) {
              assertObjectContains(testSession.meta, {
                [TEST_EARLY_FLAKE_ENABLED]: 'true',
              })
            } else {
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'impacted-test.js.impacted test should be impacted',
                'impacted-test.js.impacted test 2 should be impacted 2',
              ]
            )

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
            }

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
          }, 25000)

      const runImpactedTest = async (
        { isModified, isEfd = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew })

        childProcess = exec(
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
            playwright: {},
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
    })
  })
})
