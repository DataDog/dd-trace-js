'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
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
  TEST_STATUS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_RETRY_REASON_TYPES,
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

    contextNewVersions('early flake detection', () => {
      it('retries new tests', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with annotated tests'
              ],
              'skipped-suite-test.js': [
                'should work with fixme root',
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root',
              ],
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ENABLED]: 'true',
            })

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newPassingTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            newPassingTests.forEach(test => {
              assertObjectContains(test.meta, {
                [TEST_IS_NEW]: 'true',
              })
            })
            assert.strictEqual(
              newPassingTests.length,
              NUM_RETRIES_EFD + 1,
              'passing test has not been retried the correct number of times'
            )
            const newAnnotatedTests = tests.filter(test =>
              test.resource.endsWith('should work with annotated tests')
            )
            newAnnotatedTests.forEach(test => {
              assertObjectContains(test.meta, {
                [TEST_IS_NEW]: 'true',
              })
            })
            assert.strictEqual(
              newAnnotatedTests.length,
              NUM_RETRIES_EFD + 1,
              'annotated test has not been retried the correct number of times'
            )

            // The only new tests are the passing and annotated tests
            const totalNewTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(
              totalNewTests.length,
              newPassingTests.length + newAnnotatedTests.length,
              'total new tests is not the sum of the passing and annotated tests'
            )

            // The only retried tests are the passing and annotated tests
            const totalRetriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(
              totalRetriedTests.length,
              newPassingTests.length - 1 + newAnnotatedTests.length - 1,
              'total retried tests is not the sum of the passing and annotated tests'
            )
            assert.strictEqual(
              totalRetriedTests.length,
              NUM_RETRIES_EFD * 2,
              'total retried tests is not the correct number of times'
            )

            totalRetriedTests.forEach(test => {
              assertObjectContains(test.meta, {
                [TEST_RETRY_REASON]: TEST_RETRY_REASON_TYPES.efd,
              })
            })

            // all but one has been retried
            assert.strictEqual(totalRetriedTests.length, totalNewTests.length - 2)
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

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests',
              ],
              'skipped-suite-test.js': [
                'should work with fixme root',
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root',
              ],
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            // new tests are detected but not retried
            newTests.forEach(test => {
              assertObjectContains(test.meta, {
                [TEST_IS_NEW]: 'true',
              })
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })

      it('does not retry tests that are skipped', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                'highest-level-describe  leading and trailing spaces    should work with passing tests',
                // new but not retried because it's skipped
                // 'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                // new but not retried because it's skipped
                // 'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests',
              ],
              'skipped-suite-test.js': [
                'should work with fixme root',
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root',
              ],
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with skipped tests') ||
              test.resource.endsWith('should work with fixme')
            )
            // no retries
            assert.strictEqual(newTests.length, 2)
            newTests.forEach(test => {
              assertObjectContains(test.meta, {
                [TEST_IS_NEW]: 'true',
              })
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

            assert.strictEqual(retriedTests.length, 0)
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })

      it('does not run EFD if the known tests request fails', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({
          playwright: {},
        })

        // Request module waits before retrying; browser runs are slow — need longer gather timeout
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 7)
            const testSessionEnd = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
            const testSession = testSessionEnd.content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          }, 60000)

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

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })

      it('disables early flake detection if known tests should not be requested', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: false,
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests',
              ],
              'skipped-suite-test.js': [
                'should work with fixme root',
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root',
              ],
            },
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            newTests.forEach(test => {
              assert.ok(!(TEST_IS_NEW in test.meta))
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
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

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })

      it('does not run EFD if the known tests response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests(
          {
            'not-playwright': {},
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assertObjectContains(testSession.meta, {
              [TEST_EARLY_FLAKE_ABORT_REASON]: 'faulty',
            })

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            newTests.forEach(test => {
              assert.ok(!(TEST_IS_NEW in test.meta))
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
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

      it('does not run EFD if the percentage of new tests is too high', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 0,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({ playwright: {} })

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
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
              assertObjectContains(testSession.meta, {
                [TEST_EARLY_FLAKE_ABORT_REASON]: 'faulty',
              })

              const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
              assert.strictEqual(newTests.length, 0)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 0)
            }),
        ])
      })

      it('--retries is disabled for tests retried by EFD', async () => {
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
        })

        receiver.setKnownTests({
          playwright: {
            'flaky-test.js': ['playwright should retry old flaky tests'],
          },
        })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js --retries=1',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-efd-and-retries',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const newTests = tests.filter(
                test => test.meta[TEST_NAME] === 'playwright should not retry new tests'
              )
              assert.strictEqual(newTests.length, NUM_RETRIES_EFD + 1)
              newTests.forEach(test => {
                // tests always fail because ATR and --retries are disabled for EFD,
                // so testInfo.retry is always 0
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              })

              const retriedNewTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedNewTests.length, NUM_RETRIES_EFD)
              retriedNewTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              })

              // Only the last retry should have TEST_HAS_FAILED_ALL_RETRIES set
              const lastRetry = newTests[newTests.length - 1]
              assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

              // Earlier attempts should not have the flag
              for (let i = 0; i < newTests.length - 1; i++) {
                assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in newTests[i].meta))
              }

              // --retries works normally for old flaky tests
              const oldFlakyTests = tests.filter(
                test => test.meta[TEST_NAME] === 'playwright should retry old flaky tests'
              )
              assert.strictEqual(oldFlakyTests.length, 2)
              const passedFlakyTests = oldFlakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
              assert.strictEqual(passedFlakyTests.length, 1)
              assert.strictEqual(passedFlakyTests[0].meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(passedFlakyTests[0].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              const failedFlakyTests = oldFlakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
              assert.strictEqual(failedFlakyTests.length, 1)
            }),
        ])
      })

      it('ATR is disabled for tests retried by EFD', async () => {
        receiver.setSettings({
          known_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          flaky_test_retries_enabled: true,
        })

        receiver.setKnownTests({
          playwright: {
            'flaky-test.js': ['playwright should retry old flaky tests'],
          },
        })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-efd-and-retries',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const newTests = tests.filter(
                test => test.meta[TEST_NAME] === 'playwright should not retry new tests'
              )
              assert.strictEqual(newTests.length, NUM_RETRIES_EFD + 1)
              newTests.sort((a, b) => (a.meta.start ?? 0) - (b.meta.start ?? 0))
              newTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
              })

              const retriedNewTests = newTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedNewTests.length, NUM_RETRIES_EFD)
              retriedNewTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              })

              // Only the last retry should have TEST_HAS_FAILED_ALL_RETRIES set
              const lastRetry = newTests[newTests.length - 1]
              assert.strictEqual(lastRetry.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

              // Earlier attempts should not have the flag
              for (let i = 0; i < newTests.length - 1; i++) {
                assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in newTests[i].meta))
              }

              // ATR works normally for old flaky tests
              const oldFlakyTests = tests.filter(
                test => test.meta[TEST_NAME] === 'playwright should retry old flaky tests'
              )
              assert.strictEqual(oldFlakyTests.length, 2)
              const passedFlakyTests = oldFlakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
              assert.strictEqual(passedFlakyTests.length, 1)
              assert.strictEqual(passedFlakyTests[0].meta[TEST_IS_RETRY], 'true')
              assert.strictEqual(passedFlakyTests[0].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
              const failedFlakyTests = oldFlakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
              assert.strictEqual(failedFlakyTests.length, 1)
            }),
        ])
      })
    })
  })
})
