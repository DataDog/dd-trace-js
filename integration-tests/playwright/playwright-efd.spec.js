'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
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
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_BROWSER_NAME,
  TEST_RETRY_REASON_TYPES,
} = require('../../packages/dd-trace/src/plugins/util/test')

const { PLAYWRIGHT_VERSION } = process.env

const NUM_RETRIES_EFD = 3
const PLAYWRIGHT_EFD_GATHER_TIMEOUT = 60000

const latest = 'latest'
const { oldest } = require('./versions')
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

    contextNewVersions('early flake detection', () => {
      it('retries new tests', async (receiver, run) => {
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
          }, PLAYWRIGHT_EFD_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )
        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('uses the retry count from the matching slow_test_retries bucket', async (receiver, run) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
              '10s': 1,
              '30s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          playwright: {},
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const slowTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'efd duration retries slightly slow test'
            )
            assert.strictEqual(slowTests.length, 1)
            assert.strictEqual(slowTests[0].meta[TEST_IS_NEW], 'true')
            assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
            assert.ok(!(TEST_IS_RETRY in slowTests[0].meta))
          }, 45_000)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-efd-duration',
              PLAYWRIGHT_WORKERS: '2',
            },
          }
        )
        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('keeps duration retry counts scoped by Playwright project', async (receiver, run) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
              '10s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          playwright: {},
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const projectTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'efd project duration project scoped test'
            )
            const fastProjectTests = projectTests.filter(test => test.meta[TEST_BROWSER_NAME] === 'chromium')
            const slowProjectTests = projectTests.filter(test => test.meta[TEST_BROWSER_NAME] === 'second-chromium')

            assert.strictEqual(fastProjectTests.length, 3)
            assert.strictEqual(
              fastProjectTests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length,
              2
            )
            assert.strictEqual(slowProjectTests.length, 1)
            assert.strictEqual(slowProjectTests[0].meta[TEST_IS_NEW], 'true')
            assert.strictEqual(slowProjectTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
            assert.ok(!(TEST_IS_RETRY in slowProjectTests[0].meta))
          }, 60_000)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-efd-projects',
              ADD_DUPLICATE_PLAYWRIGHT_PROJECT: '1',
              PLAYWRIGHT_WORKERS: '2',
            },
          }
        )
        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('does not treat native repeat-each executions as EFD retries', async (receiver, run) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          playwright: {},
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const repeatedTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'efd repeat each native repeat test'
            )

            assert.strictEqual(repeatedTests.length, 3)
            for (const repeatedTest of repeatedTests) {
              assert.strictEqual(repeatedTest.meta[TEST_IS_NEW], 'true')
              assert.ok(!(TEST_IS_RETRY in repeatedTest.meta))
              assert.ok(!(TEST_RETRY_REASON in repeatedTest.meta))
            }
          }, 45_000)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js --repeat-each=3',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-efd-repeat',
              PLAYWRIGHT_WORKERS: '2',
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('keeps duration retry counts scoped by native repeat-each index', async (receiver, run) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
              '10s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          playwright: {},
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const repeatedTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'efd repeat duration repeat-scoped test'
            )

            assert.strictEqual(repeatedTests.length, 4)
            for (const repeatedTest of repeatedTests) {
              assert.strictEqual(repeatedTest.meta[TEST_IS_NEW], 'true')
            }

            const slowRepeatTests = repeatedTests.filter(
              test => test.meta[TEST_EARLY_FLAKE_ABORT_REASON] === 'slow'
            )
            assert.strictEqual(slowRepeatTests.length, 1)
            assert.ok(!(TEST_IS_RETRY in slowRepeatTests[0].meta))

            const retriedTests = repeatedTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 2)
            for (const retriedTest of retriedTests) {
              assert.strictEqual(retriedTest.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            }

            const fastOriginalTests = repeatedTests.filter(test =>
              !(TEST_IS_RETRY in test.meta) && !(TEST_EARLY_FLAKE_ABORT_REASON in test.meta)
            )
            assert.strictEqual(fastOriginalTests.length, 1)
          }, 60_000)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js --repeat-each=2',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: './ci-visibility/playwright-efd-repeat-duration',
              PLAYWRIGHT_WORKERS: '1',
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', async (receiver, run) => {
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
          }, PLAYWRIGHT_EFD_GATHER_TIMEOUT)

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('does not retry tests that are skipped', async (receiver, run) => {
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
          }, PLAYWRIGHT_EFD_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('does not run EFD if the known tests request fails', async (receiver, run) => {
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
          }, PLAYWRIGHT_EFD_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('disables early flake detection if known tests should not be requested', async (receiver, run) => {
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
          }, PLAYWRIGHT_EFD_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('does not run EFD if the known tests response is invalid', async (receiver, run) => {
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
          }, PLAYWRIGHT_EFD_GATHER_TIMEOUT)

        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('does not run EFD if the percentage of new tests is too high', async (receiver, run) => {
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

        const proc = run(
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
          once(proc, 'exit'),
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
            }, PLAYWRIGHT_EFD_GATHER_TIMEOUT),
        ])
      })

      it('--retries is disabled for tests retried by EFD', async (receiver, run) => {
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

        const proc = run(
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
          once(proc, 'exit'),
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

              const failedAllRetries = newTests.filter(test => test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true')
              assert.strictEqual(failedAllRetries.length, 1)

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
            }, PLAYWRIGHT_EFD_GATHER_TIMEOUT),
        ])
      })

      it('ATR is disabled for tests retried by EFD', async (receiver, run) => {
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

        const proc = run(
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
          once(proc, 'exit'),
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

              const failedAllRetries = newTests.filter(test => test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true')
              assert.strictEqual(failedAllRetries.length, 1)

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
            }, PLAYWRIGHT_EFD_GATHER_TIMEOUT),
        ])
      })
    })
  })
})
