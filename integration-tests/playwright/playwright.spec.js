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
  getCiVisEvpProxyConfig,
  assertObjectContains,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const { createWebAppServerWithRedirect } = require('../ci-visibility/web-app-server-with-redirect')
const {
  TEST_STATUS,
  TEST_SOURCE_START,
  TEST_TYPE,
  TEST_SOURCE_FILE,
  TEST_PARAMETERS,
  TEST_BROWSER_NAME,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_VERSION,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
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
    let cwd, receiver, childProcess, webAppPort, webPortWithRedirect, webAppServer, webAppServerWithRedirect

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

      // Create fresh server instances to avoid issues with retries
      webAppServer = createWebAppServer()
      webAppServerWithRedirect = createWebAppServerWithRedirect()

      webAppServer.listen(0, (err) => {
        if (err) {
          return done(err)
        }
        webAppPort = webAppServer.address().port

        webAppServerWithRedirect.listen(0, (err) => {
          if (err) {
            return done(err)
          }
          webPortWithRedirect = webAppServerWithRedirect.address().port
          done()
        })
      })
    })

    after(async () => {
      await new Promise(resolve => webAppServer.close(resolve))
      await new Promise(resolve => webAppServerWithRedirect.close(resolve))
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })
    const reportMethods = ['agentless', 'evp proxy']

    reportMethods.forEach((reportMethod) => {
      context(`reporting via ${reportMethod}`, () => {
        it('tags session and children with _dd.ci.library_configuration_error when settings fail 4xx', async () => {
          const envVars = reportMethod === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          receiver.setSettingsResponseCode(404)
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testSession = events.find(event => event.type === 'test_session_end').content
              assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true')
              const testEvent = events.find(event => event.type === 'test')
              assert.ok(testEvent, 'should have test event')
              assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true')
            })
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...envVars,
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                DD_TEST_SESSION_NAME: 'my-test-session',
              },
            }
          )
          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        it('can run and report tests', (done) => {
          const envVars = reportMethod === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          const reportUrl = reportMethod === 'agentless' ? '/api/v2/citestcycle' : '/evp_proxy/v2/api/v2/citestcycle'

          receiver.gatherPayloadsMaxTimeout(({ url }) => url === reportUrl, payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            metadataDicts.forEach(metadata => {
              for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
                assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
              }
            })

            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const stepEvents = events.filter(event => event.type === 'span')

            assert.ok(testSessionEvent.content.resource.includes('test_session.playwright test'))
            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.ok(testModuleEvent.content.resource.includes('test_module.playwright test'))
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'browser')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'browser')

            assert.strictEqual(typeof testSessionEvent.content.meta[ERROR_MESSAGE], 'string')
            assert.strictEqual(typeof testModuleEvent.content.meta[ERROR_MESSAGE], 'string')

            assert.deepStrictEqual(testSuiteEvents.map(suite => suite.content.resource).sort(), [
              'test_suite.landing-page-test.js',
              'test_suite.skipped-suite-test.js',
              'test_suite.todo-list-page-test.js',
            ])

            assert.deepStrictEqual(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]).sort(), [
              'fail',
              'pass',
              'skip',
            ])

            testSuiteEvents.forEach(testSuiteEvent => {
              if (testSuiteEvent.content.meta[TEST_STATUS] === 'fail') {
                assert.ok(testSuiteEvent.content.meta[ERROR_MESSAGE])
              }
              assert.ok(testSuiteEvent.content.meta[TEST_SOURCE_FILE].endsWith('-test.js'))
              assert.strictEqual(testSuiteEvent.content.metrics[TEST_SOURCE_START], 1)
              assert.ok(testSuiteEvent.content.metrics[DD_HOST_CPU_COUNT])
            })

            assert.deepStrictEqual(testEvents.map(test => test.content.resource).sort(), [
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with annotated tests',
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with fixme',
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with passing tests',
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with skipped tests',
              'skipped-suite-test.js.should work with fixme root',
              'todo-list-page-test.js.playwright should work with failing tests',
              'todo-list-page-test.js.should work with fixme root',
            ])

            assertObjectContains(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip',
            ])

            testEvents.forEach(testEvent => {
              assert.ok(testEvent.content.metrics[TEST_SOURCE_START])
              assert.strictEqual(
                testEvent.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/playwright-tests/'),
                true
              )
              assert.strictEqual(testEvent.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
              // Can read DD_TAGS
              assertObjectContains(testEvent.content.meta, {
                'test.customtag': 'customvalue',
                'test.customtag2': 'customvalue2',
                // Adds the browser used
                [TEST_BROWSER_NAME]: 'chromium',
                [TEST_PARAMETERS]: JSON.stringify({ arguments: { browser: 'chromium' }, metadata: {} }),
              })
              assert.ok(testEvent.content.metrics[DD_HOST_CPU_COUNT])
              if (version === 'latest' || satisfies(version, '>=1.38.0')) {
                if (testEvent.content.meta[TEST_STATUS] !== 'skip' &&
                  testEvent.content.meta[TEST_SUITE].includes('landing-page-test.js')) {
                  assertObjectContains(testEvent.content.meta, {
                    'custom_tag.beforeEach': 'hello beforeEach',
                    'custom_tag.afterEach': 'hello afterEach',
                  })
                }
                if (testEvent.content.meta[TEST_NAME].includes('should work with passing tests')) {
                  assertObjectContains(testEvent.content.meta, {
                    'custom_tag.it': 'hello it',
                  })
                }
              }
            })

            stepEvents.forEach(stepEvent => {
              assert.strictEqual(stepEvent.content.name, 'playwright.step')
              assert.ok(Object.hasOwn(stepEvent.content.meta, 'playwright.step'))
            })
            const annotatedTest = testEvents.find(test =>
              test.content.resource.endsWith('should work with annotated tests')
            )

            assertObjectContains(annotatedTest.content, {
              meta: {
                'test.memory.usage': 'low',
              },
              metrics: {
                'test.memory.allocations': 16,
              },
            })
            assert.ok(!('test.invalid' in annotatedTest.content.meta))
          }).then(() => done()).catch(done)

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...envVars,
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
                DD_TEST_SESSION_NAME: 'my-test-session',
                DD_SERVICE: undefined,
              },
            }
          )
        })
      })
    })

    it('works when tests are compiled to a different location', function (done) {
      // this has shown some flakiness
      this.retries(1)
      let testOutput = ''

      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event => event.type === 'test')
        assertObjectContains(testEvents.map(test => test.content.resource).sort(), [
          'playwright-tests-ts/one-test.js.playwright should work with passing tests',
          'playwright-tests-ts/one-test.js.playwright should work with skipped tests',
        ])
        assert.match(testOutput, /1 passed/)
        assert.match(testOutput, /1 skipped/)
        assert.doesNotMatch(testOutput, /TypeError/)
      }, 25000).then(() => done()).catch(done)

      childProcess = exec(
        'node ./node_modules/typescript/bin/tsc' +
        '&& ./node_modules/.bin/playwright test -c ci-visibility/playwright-tests-ts-out',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            PW_RUNNER_DEBUG: '1',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
      })
    })

    it('works when before all fails and step durations are negative', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSuiteEvent = events.find(event => event.type === 'test_suite_end').content
        const testSessionEvent = events.find(event => event.type === 'test_session_end').content

        assertObjectContains(testSuiteEvent.meta, {
          [TEST_STATUS]: 'fail',
        })
        assertObjectContains(testSessionEvent.meta, {
          [TEST_STATUS]: 'fail',
        })
        assert.ok(testSuiteEvent.meta[ERROR_MESSAGE])
        assert.match(testSessionEvent.meta[ERROR_MESSAGE], /Test suites failed: 1/)
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            TEST_DIR: './ci-visibility/playwright-tests-error',
            TEST_TIMEOUT: '3000',
          },
        }
      )
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

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 7)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

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

    it('does not crash when maxFailures=1 and there is an error', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testEvents = events.filter(event => event.type === 'test')

        assertObjectContains(testEvents.map(test => test.content.resource), [
          'failing-test-and-another-test.js.should work with failing tests',
          'failing-test-and-another-test.js.does not crash afterwards',
        ])
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            MAX_FAILURES: '1',
            TEST_DIR: './ci-visibility/playwright-tests-max-failures',
          },
        }
      )
    })

    context('flaky test retries', () => {
      it('can automatically retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
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
          }, 30000)

        childProcess = exec(
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

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests.filter(
              (test) => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 0)
          }, 30000)

        childProcess = exec(
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

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 2)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 2)

            const failedRetryTests = failedTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )
            assert.strictEqual(failedRetryTests.length, 1)
          }, 30000)

        childProcess = exec(
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

        childProcess.on('exit', () => {
          receiverPromise
            .then(() => done())
            .catch(done)
        })
      })
    })

    it('correctly calculates test code owners when working directory is not repository root', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          // The test is in a subproject
          assert.notStrictEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        })

      childProcess = exec(
        '../../node_modules/.bin/playwright test',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            PW_RUNNER_DEBUG: '1',
            TEST_DIR: '.',
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    contextNewVersions('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
        receiver.setSettings({
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

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            // new tests detected but no retries
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
    })

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', (done) => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          tests.forEach(test => {
            assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        })

      childProcess = exec(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            DD_SERVICE: 'my-service',
          },
        }
      )

      childProcess.on('exit', () => {
        receiverPromise.then(() => done()).catch(done)
      })
    })

    contextNewVersions('test management', () => {
      const ATTEMPT_TO_FIX_NUM_RETRIES = 3
      context('attempt to fix', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'attempt-to-fix-test.js': {
                  tests: {
                    'attempt to fix should attempt to fix failed test': {
                      properties: {
                        attempt_to_fix: true,
                      },
                    },
                    'attempt to fix should attempt to fix passed test': {
                      properties: {
                        attempt_to_fix: true,
                      },
                    },
                  },
                },
              },
            },
          })
        })

        const getTestAssertions = ({
          isAttemptingToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled,
          isQuarantined,
          shouldIncludeFlakyTest,
        }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isAttemptingToFix) {
                assertObjectContains(testSession.meta, {
                  [TEST_MANAGEMENT_ENABLED]: 'true',
                })
              } else {
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              }

              const attemptedToFixTests = tests.filter(
                test => test.meta[TEST_NAME].startsWith('attempt to fix should attempt to fix')
              )

              if (isDisabled && !isAttemptingToFix) {
                assert.strictEqual(attemptedToFixTests.length, 2)
                assert.ok(attemptedToFixTests.every(test =>
                  test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'
                ))
                // if the test is disabled and not attempting to fix, there will be no retries
                return
              }

              if (isAttemptingToFix) {
                assert.strictEqual(attemptedToFixTests.length, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
              } else {
                assert.strictEqual(attemptedToFixTests.length, 2)
              }

              if (isDisabled) {
                const numDisabledTests = attemptedToFixTests.filter(test =>
                  test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'
                ).length
                // disabled tests with attemptToFix still run and are retried
                assert.strictEqual(numDisabledTests, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
                // disabled tests with attemptToFix should not be skipped - they should run with pass/fail status
                const skippedDisabledTests = attemptedToFixTests.filter(test =>
                  test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true' &&
                  test.meta[TEST_STATUS] === 'skip'
                ).length
                assert.strictEqual(skippedDisabledTests, 0, 'disabled tests with attemptToFix should not be skipped')
              }

              if (isQuarantined) {
                const numQuarantinedTests = attemptedToFixTests.filter(test =>
                  test.meta[TEST_MANAGEMENT_IS_QUARANTINED] === 'true'
                ).length
                // quarantined tests still run and are retried
                assert.strictEqual(numQuarantinedTests, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
              }

              // Retried tests are in randomly order, so we just count number of tests
              const countAttemptToFixTests = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true'
              ).length

              const countRetriedAttemptToFixTests = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true' &&
                test.meta[TEST_IS_RETRY] === 'true' &&
                test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atf
              ).length

              const testsMarkedAsFailedAllRetries = attemptedToFixTests.filter(test =>
                test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true'
              ).length

              const testsMarkedAsPassedAllRetries = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED] === 'true'
              ).length

              const testsMarkedAsFailed = attemptedToFixTests.filter(test =>
                test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED] === 'false'
              ).length

              // One of the tests is passing always
              if (isAttemptingToFix) {
                assert.strictEqual(countAttemptToFixTests, 2 * (ATTEMPT_TO_FIX_NUM_RETRIES + 1))
                assert.strictEqual(countRetriedAttemptToFixTests, 2 * ATTEMPT_TO_FIX_NUM_RETRIES)
                if (shouldAlwaysPass) {
                  assert.strictEqual(testsMarkedAsFailedAllRetries, 0)
                  assert.strictEqual(testsMarkedAsFailed, 0)
                  assert.strictEqual(testsMarkedAsPassedAllRetries, 2)
                } else if (shouldFailSometimes) {
                  // one test failed sometimes, the other always passed
                  assert.strictEqual(testsMarkedAsFailedAllRetries, 0)
                  assert.strictEqual(testsMarkedAsFailed, 1)
                  assert.strictEqual(testsMarkedAsPassedAllRetries, 1)
                } else {
                  // one test failed always, the other always passed
                  assert.strictEqual(testsMarkedAsFailedAllRetries, 1)
                  assert.strictEqual(testsMarkedAsFailed, 1)
                  assert.strictEqual(testsMarkedAsPassedAllRetries, 1)
                }
              } else {
                assert.strictEqual(countAttemptToFixTests, 0)
                assert.strictEqual(countRetriedAttemptToFixTests, 0)
                assert.strictEqual(testsMarkedAsFailedAllRetries, 0)
                assert.strictEqual(testsMarkedAsPassedAllRetries, 0)
              }
              if (shouldIncludeFlakyTest) {
                const flakyTests = tests.filter(
                  test => test.meta[TEST_NAME] === 'flaky test is retried without attempt to fix'
                )
                // it passes at the second attempt
                assert.strictEqual(flakyTests.length, 2)
                const passedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
                const failedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
                assert.strictEqual(passedFlakyTest.length, 1)
                assert.strictEqual(failedFlakyTest.length, 1)
              }
            }, 30000)

        /**
         * @param {{
         *   isAttemptingToFix?: boolean,
         *   isQuarantined?: boolean,
         *   extraEnvVars?: Record<string, string>,
         *   shouldAlwaysPass?: boolean,
         *   shouldFailSometimes?: boolean,
         *   isDisabled?: boolean,
         *   shouldIncludeFlakyTest?: boolean,
         *   cliArgs?: string
         * }} [options]
         */
        const runAttemptToFixTest = async ({
          isAttemptingToFix,
          isQuarantined,
          extraEnvVars,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled,
          shouldIncludeFlakyTest,
          cliArgs = 'attempt-to-fix-test.js',
        } = {}) => {
          const testAssertionsPromise = getTestAssertions({
            isAttemptingToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isDisabled,
            isQuarantined,
            shouldIncludeFlakyTest,
          })

          childProcess = exec(
            `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
                ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
                ...(shouldIncludeFlakyTest ? { SHOULD_INCLUDE_FLAKY_TEST: '1' } : {}),
                ...extraEnvVars,
              },
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

          if (isQuarantined || isDisabled || shouldAlwaysPass) {
            // even though a test fails, the exit code is 0 because the test is quarantined
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can attempt to fix and mark last attempt as failed if every attempt fails', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true })
        })

        it('can attempt to fix and mark last attempt as passed if every attempt passes', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true, shouldAlwaysPass: true })
        })

        it('can attempt to fix and not mark last attempt if attempts both pass and fail', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true, shouldFailSometimes: true })
        })

        it('does not attempt to fix tests if test management is not enabled', async () => {
          receiver.setSettings({
            test_management: { enabled: false, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest()
        })

        it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({ extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
        })

        it('does not fail retry if a test is quarantined', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'attempt-to-fix-test.js': {
                  tests: {
                    'attempt to fix should attempt to fix failed test': {
                      properties: {
                        attempt_to_fix: true,
                        quarantined: true,
                      },
                    },
                    'attempt to fix should attempt to fix passed test': {
                      properties: {
                        attempt_to_fix: true,
                        quarantined: true,
                      },
                    },
                  },
                },
              },
            },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true, isQuarantined: true })
        })

        it('does not fail retry if a test is disabled', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'attempt-to-fix-test.js': {
                  tests: {
                    'attempt to fix should attempt to fix failed test': {
                      properties: {
                        attempt_to_fix: true,
                        disabled: true,
                      },
                    },
                    'attempt to fix should attempt to fix passed test': {
                      properties: {
                        attempt_to_fix: true,
                        disabled: true,
                      },
                    },
                  },
                },
              },
            },
          })

          await runAttemptToFixTest({ isAttemptingToFix: true, isDisabled: true })
        })

        it('--retries is disabled for an attempt to fix test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
          })

          await runAttemptToFixTest({
            isAttemptingToFix: true,
            shouldFailSometimes: true,
            // passing retries has no effect
            cliArgs: 'attempt-to-fix-test.js --retries=20',
            shouldIncludeFlakyTest: true,
          })
        })

        it('ATR is disabled for an attempt to fix test', async () => {
          receiver.setSettings({
            test_management: { enabled: true, attempt_to_fix_retries: ATTEMPT_TO_FIX_NUM_RETRIES },
            flaky_test_retries_enabled: true,
          })

          await runAttemptToFixTest({
            isAttemptingToFix: true,
            shouldFailSometimes: true,
            extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '20' },
            shouldIncludeFlakyTest: true,
          })
        })
      })

      context('disabled', () => {
        let testOutput = ''
        beforeEach(() => {
          testOutput = ''
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'disabled-test.js': {
                  tests: {
                    'disable should disable test': {
                      properties: {
                        disabled: true,
                      },
                    },
                  },
                },
                'disabled-2-test.js': {
                  tests: {
                    'disable should disable test': {
                      properties: {
                        disabled: true,
                      },
                    },
                  },
                },
              },
            },
          })
        })

        const getTestAssertions = (isDisabling) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const resourceNames = events.filter(event => event.type === 'test').map(event => event.content.resource)
              assertObjectContains(resourceNames.sort(), [
                'disabled-test.js.disable should disable test',
                'disabled-test.js.not disabled should not disable test',
                'disabled-test.js.not disabled 2 should not disable test 2',
                'disabled-test.js.not disabled 3 should not disable test 3',
                'disabled-2-test.js.disable should disable test',
                'disabled-2-test.js.not disabled should not disable test',
                'disabled-2-test.js.not disabled 2 should not disable test 2',
                'disabled-2-test.js.not disabled 3 should not disable test 3',
              ].sort())

              const testSession = events.find(event => event.type === 'test_session_end').content
              if (isDisabling) {
                assertObjectContains(testSession.meta, {
                  [TEST_MANAGEMENT_ENABLED]: 'true',
                })
              } else {
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              }

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 8)

              const disabledTests = tests.filter(test => test.meta[TEST_NAME] === 'disable should disable test')
              assert.strictEqual(disabledTests.length, 2)

              disabledTests.forEach(test => {
                if (isDisabling) {
                  assert.strictEqual(test.meta[TEST_STATUS], 'skip')
                  assertObjectContains(test.meta, {
                    [TEST_MANAGEMENT_IS_DISABLED]: 'true',
                  })
                } else {
                  assert.strictEqual(test.meta[TEST_STATUS], 'fail')
                  assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in test.meta))
                }
              })
            }, 25000)

        const runDisableTest = async (isDisabling, extraEnvVars) => {
          const testAssertionsPromise = getTestAssertions(isDisabling)

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js disabled-test.js disabled-2-test.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars,
              },
            }
          )

          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            once(childProcess.stdout, 'end'),
            once(childProcess.stderr, 'end'),
            testAssertionsPromise,
          ])

          // the testOutput checks whether the test is actually skipped
          if (isDisabling) {
            assert.doesNotMatch(testOutput, /SHOULD NOT BE EXECUTED/)
            assert.strictEqual(exitCode, 0)
          } else {
            assert.match(testOutput, /SHOULD NOT BE EXECUTED/)
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can disable tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(true)
        })

        it('can disable tests in fullyParallel mode', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(true, { FULLY_PARALLEL: true, PLAYWRIGHT_WORKERS: '3' })
        })

        it('fails if disable is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false } })

          await runDisableTest(false)
        })

        it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runDisableTest(false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })

      context('quarantine', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'quarantine-test.js': {
                  tests: {
                    'quarantine should quarantine failed test': {
                      properties: {
                        quarantined: true,
                      },
                    },
                  },
                },
              },
            },
          })
        })

        const getTestAssertions = ({ isQuarantining, hasFlakyTests }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content

              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const flakyTests = tests.filter(test => test.meta[TEST_NAME] === 'flaky should be flaky')
              const quarantinedTests = tests.filter(
                test => test.meta[TEST_NAME] === 'quarantine should quarantine failed test'
              )

              quarantinedTests.forEach(test => {
                assert.strictEqual(test.meta[TEST_STATUS], 'fail')
              })

              if (hasFlakyTests) {
                assert.strictEqual(flakyTests.length, 2) // first attempt fails, second attempt passes
                assert.strictEqual(quarantinedTests.length, 2) // both fail
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in flakyTests[0].meta))
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in flakyTests[1].meta))
                const failedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'fail')
                const passedFlakyTest = flakyTests.filter(test => test.meta[TEST_STATUS] === 'pass')
                assert.strictEqual(failedFlakyTest.length, 1)
                assert.strictEqual(passedFlakyTest.length, 1)
              }

              if (isQuarantining) {
                if (hasFlakyTests) {
                  assert.strictEqual(quarantinedTests[1].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                } else {
                  assert.strictEqual(quarantinedTests.length, 1)
                }
                assert.strictEqual(quarantinedTests[0].meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
                assertObjectContains(testSession.meta, {
                  [TEST_MANAGEMENT_ENABLED]: 'true',
                })
              } else {
                if (hasFlakyTests) {
                  assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTests[1].meta))
                } else {
                  assert.strictEqual(quarantinedTests.length, 1)
                }
                assert.ok(!(TEST_MANAGEMENT_IS_QUARANTINED in quarantinedTests[0].meta))
                assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
              }
            }, 25000)

        /**
         * @param {{
         *   isQuarantining?: boolean,
         *   extraEnvVars?: Record<string, string>,
         *   cliArgs?: string,
         *   hasFlakyTests?: boolean
         * }} options
         */
        const runQuarantineTest = async ({
          isQuarantining,
          extraEnvVars,
          cliArgs = 'quarantine-test.js',
          hasFlakyTests = false,
        }) => {
          const testAssertionsPromise = getTestAssertions({ isQuarantining, hasFlakyTests })

          childProcess = exec(
            `./node_modules/.bin/playwright test -c playwright.config.js ${cliArgs}`,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars,
              },
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            testAssertionsPromise,
          ])

          if (isQuarantining) {
            assert.strictEqual(exitCode, 0)
          } else {
            assert.strictEqual(exitCode, 1)
          }
        }

        it('can quarantine tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runQuarantineTest({ isQuarantining: true })
        })

        it('can quarantine tests when there are other flaky tests retried with --retries', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runQuarantineTest({
            isQuarantining: true,
            cliArgs: 'quarantine-test.js quarantine-2-test.js --retries=1',
            hasFlakyTests: true,
          })
        })

        it('can quarantine tests when there are other flaky tests retried with ATR', async () => {
          receiver.setSettings({
            test_management: { enabled: true },
            flaky_test_retries_enabled: true,
          })

          await runQuarantineTest({
            isQuarantining: true,
            cliArgs: 'quarantine-test.js quarantine-2-test.js',
            hasFlakyTests: true,
            extraEnvVars: { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1' },
          })
        })

        it('fails if quarantine is not enabled', async () => {
          receiver.setSettings({ test_management: { enabled: false } })

          await runQuarantineTest({ isQuarantining: false })
        })

        it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', async () => {
          receiver.setSettings({ test_management: { enabled: true } })

          await runQuarantineTest({ isQuarantining: false, extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
        })
      })

      it('does not crash if the request to get test management tests fails', async () => {
        let testOutput = ''
        receiver.setSettings({
          test_management: { enabled: true },
          flaky_test_retries_enabled: false,
        })
        receiver.setTestManagementTestsResponseCode(500)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_MANAGEMENT_ENABLED in testSession.meta))
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            // they are not retried
            assert.strictEqual(tests.length, 2)
            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js attempt-to-fix-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-management',
              DD_TRACE_DEBUG: '1',
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          eventsPromise,
        ])
        assert.match(testOutput, /Test management tests could not be fetched/)
      })
    })

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0)
            metadataDicts.forEach(metadata => {
              assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
              assert.strictEqual(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
              if (satisfies(version, '>=1.38.0') || version === 'latest') {
                assert.strictEqual(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
                assert.strictEqual(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
              } else {
                assert.strictEqual(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], undefined)
                assert.strictEqual(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], undefined)
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], undefined)
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], undefined)
                assert.strictEqual(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], undefined)
                assert.strictEqual(metadata.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], undefined)
              }
              // capabilities logic does not overwrite test session name
              assert.strictEqual(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
            })
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-capabilities',
              DD_TEST_SESSION_NAME: 'my-test-session-name',
            },
          }
        )

        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    contextNewVersions('active test span', () => {
      it('can grab the test span and add tags', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const test = events.find(event => event.type === 'test').content

            assert.strictEqual(test.meta['test.custom_tag'], 'this is custom')
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js active-test-span-tags-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-active-test-span',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })

      it('can grab the test span and add spans', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const test = events.find(event => event.type === 'test').content
            const spans = events.filter(event => event.type === 'span').map(event => event.content)

            const customSpan = spans.find(span => span.name === 'my custom span')

            assert.ok(customSpan)
            assert.strictEqual(customSpan.meta['test.really_custom_tag'], 'this is really custom')

            // custom span is children of active test span
            assert.strictEqual(customSpan.trace_id.toString(), test.trace_id.toString())
            assert.strictEqual(customSpan.parent_id.toString(), test.span_id.toString())
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js active-test-span-custom-span-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-active-test-span',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })
    })

    contextNewVersions('correlation between tests and RUM sessions', () => {
      const getTestAssertions = ({ isRedirecting }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            tests.forEach(test => {
              if (isRedirecting) {
                // can't do assertions because playwright has been redirected
                assertObjectContains(test.meta, {
                  [TEST_STATUS]: 'fail',
                })
                assert.ok(!(TEST_IS_RUM_ACTIVE in test.meta))
                assert.ok(!(TEST_BROWSER_VERSION in test.meta))
              } else {
                assertObjectContains(test.meta, {
                  [TEST_STATUS]: 'pass',
                  [TEST_IS_RUM_ACTIVE]: 'true',
                })
                assert.ok(Object.hasOwn(test.meta, TEST_BROWSER_VERSION))
              }
            })
          })

      const runRumTest = async ({ isRedirecting }, extraEnvVars) => {
        const testAssertionsPromise = getTestAssertions({ isRedirecting })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${isRedirecting ? webPortWithRedirect : webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-rum',
              ...extraEnvVars,
            },
          }
        )

        await Promise.all([
          once(childProcess, 'exit'),
          testAssertionsPromise,
        ])
      }

      it('can correlate tests and RUM sessions', async () => {
        await runRumTest({ isRedirecting: false })
      })

      it('sends telemetry for RUM browser tests when telemetry is enabled', async () => {
        const telemetryPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
            const telemetryEvents = payloads.flatMap(({ payload }) => payload.payload.series)

            const testSessionMetric = telemetryEvents.find(
              ({ metric }) => metric === 'test_session'
            )
            assert.ok(testSessionMetric, 'test_session telemetry metric should be sent')

            const eventFinishedTestEvents = telemetryEvents
              .filter(({ metric, tags }) => metric === 'event_finished' && tags.includes('event_type:test'))

            eventFinishedTestEvents.forEach(({ tags }) => {
              assert.ok(tags.includes('is_rum'))
              assert.ok(tags.includes('test_framework:playwright'))
            })
          })

        await Promise.all([
          runRumTest(
            { isRedirecting: false },
            {
              ...getCiVisEvpProxyConfig(receiver.port),
              DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            }
          ),
          telemetryPromise,
        ])
      })

      it('do not crash when redirecting and RUM sessions are not active', async () => {
        await runRumTest({ isRedirecting: true })
      })
    })

    context('run session status', () => {
      it('session status is not changed if it fails before running any test', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          })

        receiver.setSettings({ test_management: { enabled: true } })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js exit-code-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-exit-code',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          assert.strictEqual(exitCode, 1)
          receiverPromise.then(() => done()).catch(done)
        })
      })
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

    contextNewVersions('check retries tagging', () => {
      it('does not send attempt to fix tags if test is retried and not attempt to fix', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, NUM_RETRIES_EFD + 1)
            for (const test of tests) {
              assert.ok(!(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta))
              assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
            }
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
          test_management: {
            attempt_to_fix_retries: NUM_RETRIES_EFD,
          },
        })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js retried-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-retries-tagging',
            },
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(done).catch(done)
        })
      })
    })

    const fullyParallelConfigValue = [true, false]

    fullyParallelConfigValue.forEach((parallelism) => {
      context(`with fullyParallel=${parallelism}`, () => {
        /**
         * Due to a bug in the playwright plugin, durations of test suites that included skipped tests
         * were not reported correctly, as they dragged out until the end of the test session.
         * This test checks that a long suite, which makes the test session longer,
         * does not affect the duration of a short suite, which is expected to finish earlier.
         * This only happened with tests that included skipped tests.
         */
        it('should report the correct test suite duration when there are skipped tests', async () => {
          const receiverPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
              assert.strictEqual(testSuites.length, 2)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 3)

              const skippedTest = tests.find(test => test.meta[TEST_STATUS] === 'skip')
              assertObjectContains(
                skippedTest.meta,
                {
                  [TEST_NAME]: 'short suite should skip and not mess up the duration of the test suite',
                },
              )
              const shortSuite = testSuites.find(suite => suite.meta[TEST_SUITE].endsWith('short-suite-test.js'))
              const longSuite = testSuites.find(suite => suite.meta[TEST_SUITE].endsWith('long-suite-test.js'))
              // The values are not deterministic, so we can only assert that they're distant enough
              // This checks that the long suite takes at least twice longer than the short suite
              assert.ok(
                Number(longSuite.duration) > Number(shortSuite.duration) * 2,
                'The long test suite should take at least twice as long as the short suite, ' +
                'but their durations are: \n' +
                `- Long suite: ${Number(longSuite.duration) / 1e6}ms \n` +
                `- Short suite: ${Number(shortSuite.duration) / 1e6}ms`
              )
            })

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-test-duration',
                FULLY_PARALLEL: String(parallelism),
                PLAYWRIGHT_WORKERS: '2',
              },
            }
          )

          await Promise.all([
            receiverPromise,
            once(childProcess, 'exit'),
          ])
        })
      })
    })

    contextNewVersions('playwright early bail', () => {
      it('reports tests that did not run', async () => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)
            const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
            assertObjectContains(failedTest.meta, {
              [TEST_NAME]: 'failing test fails and causes early bail',
            })
            const didNotRunTest = tests.find(test => test.meta[TEST_STATUS] === 'skip')
            assertObjectContains(didNotRunTest.meta, {
              [TEST_NAME]: 'did not run because of early bail',
            })
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-did-not-run',
              ADD_EXTRA_PLAYWRIGHT_PROJECT: 'true',
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
