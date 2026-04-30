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
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_SESSION_NAME,
  TEST_RETRY_REASON,
  TEST_NAME,
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

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
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
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      // Note: Cypress binary is already installed during useSandbox() via the postinstall script
      // when the cypress npm package is installed, so no explicit install is needed here
      cwd = sandboxCwd()
    })

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

    context('libraries capabilities', () => {
      it('adds capabilities to tests', async () => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads
              .filter(({ payload }) => payload.metadata?.test)
              .flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0)
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
              assert.strictEqual(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
            })
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/spec.cy.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              DD_TEST_SESSION_NAME: 'my-test-session-name',
              SPEC_PATTERN: specToRun,
            },
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

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

      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew })

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
              ...extraEnvVars,
            },
          }
        )

        // TODO: remove this once we have figured out flakiness
        childProcess.stdout?.pipe(process.stdout)
        childProcess.stderr?.pipe(process.stderr)

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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
              CYPRESS_TEST_ISOLATION: 'false',
            },
          }
        )

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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          }, 25000)

        const envVars = getCiVisEvpProxyConfig(receiver.port)

        const specToRun = 'cypress/e2e/impacted-test-order.js'

        childProcess = exec(
          version === 'latest' ? testCommand : `${testCommand} --spec ${specToRun}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: specToRun,
              GITHUB_BASE_REF: '',
            },
          }
        )

        childProcess.stdout?.on('data', (data) => {
          testOutput += data.toString()
        })
        childProcess.stderr?.on('data', (data) => {
          testOutput += data.toString()
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
