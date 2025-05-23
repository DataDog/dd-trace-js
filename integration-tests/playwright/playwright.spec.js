'use strict'

const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('../ci-visibility/web-app-server')
const webAppServerWithRedirect = require('../ci-visibility/web-app-server-with-redirect')
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
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_VERSION,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR } = require('../../version')

const NUM_RETRIES_EFD = 3

const versions = [DD_MAJOR >= 6 ? '1.38.0' : '1.18.0', 'latest']

versions.forEach((version) => {
  describe(`playwright@${version}`, () => {
    let sandbox, cwd, receiver, childProcess, webAppPort, webPortWithRedirect

    before(async function () {
      // bump from 60 to 90 seconds because playwright is heavy
      this.timeout(90000)
      sandbox = await createSandbox([`@playwright/test@${version}`, 'typescript'], true)
      cwd = sandbox.folder
      const { NODE_OPTIONS, ...restOfEnv } = process.env
      // Install chromium (configured in integration-tests/playwright.config.js)
      // *Be advised*: this means that we'll only be using chromium for this test suite
      execSync('npx playwright install chromium', { cwd, env: restOfEnv, stdio: 'inherit' })
      webAppPort = await getPort()
      webAppServer.listen(webAppPort)
      webPortWithRedirect = await getPort()
      webAppServerWithRedirect.listen(webPortWithRedirect)
    })

    after(async () => {
      await sandbox.remove()
      await new Promise(resolve => webAppServer.close(resolve))
      await new Promise(resolve => webAppServerWithRedirect.close(resolve))
    })

    beforeEach(async function () {
      const port = await getPort()
      receiver = await new FakeCiVisIntake(port).start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })
    const reportMethods = ['agentless', 'evp proxy']

    reportMethods.forEach((reportMethod) => {
      context(`reporting via ${reportMethod}`, () => {
        it('can run and report tests', (done) => {
          const envVars = reportMethod === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          const reportUrl = reportMethod === 'agentless' ? '/api/v2/citestcycle' : '/evp_proxy/v2/api/v2/citestcycle'

          receiver.gatherPayloadsMaxTimeout(({ url }) => url === reportUrl, payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            metadataDicts.forEach(metadata => {
              for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
                assert.equal(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
              }
            })

            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const stepEvents = events.filter(event => event.type === 'span')

            assert.include(testSessionEvent.content.resource, 'test_session.playwright test')
            assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.include(testModuleEvent.content.resource, 'test_module.playwright test')
            assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.equal(testSessionEvent.content.meta[TEST_TYPE], 'browser')
            assert.equal(testModuleEvent.content.meta[TEST_TYPE], 'browser')

            assert.exists(testSessionEvent.content.meta[ERROR_MESSAGE])
            assert.exists(testModuleEvent.content.meta[ERROR_MESSAGE])

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
              'test_suite.todo-list-page-test.js',
              'test_suite.landing-page-test.js',
              'test_suite.skipped-suite-test.js'
            ])

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip'
            ])

            testSuiteEvents.forEach(testSuiteEvent => {
              if (testSuiteEvent.content.meta[TEST_STATUS] === 'fail') {
                assert.exists(testSuiteEvent.content.meta[ERROR_MESSAGE])
              }
              assert.isTrue(testSuiteEvent.content.meta[TEST_SOURCE_FILE].endsWith('-test.js'))
              assert.equal(testSuiteEvent.content.metrics[TEST_SOURCE_START], 1)
              assert.exists(testSuiteEvent.content.metrics[DD_HOST_CPU_COUNT])
            })

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with passing tests',
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with skipped tests',
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with fixme',
              'landing-page-test.js.highest-level-describe' +
              '  leading and trailing spaces    should work with annotated tests',
              'todo-list-page-test.js.playwright should work with failing tests',
              'todo-list-page-test.js.should work with fixme root'
            ])

            assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip'
            ])

            testEvents.forEach(testEvent => {
              assert.exists(testEvent.content.metrics[TEST_SOURCE_START])
              assert.equal(
                testEvent.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/playwright-tests/'), true
              )
              assert.equal(testEvent.content.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
              // Can read DD_TAGS
              assert.propertyVal(testEvent.content.meta, 'test.customtag', 'customvalue')
              assert.propertyVal(testEvent.content.meta, 'test.customtag2', 'customvalue2')
              // Adds the browser used
              assert.propertyVal(testEvent.content.meta, TEST_BROWSER_NAME, 'chromium')
              assert.propertyVal(
                testEvent.content.meta,
                TEST_PARAMETERS,
                JSON.stringify({ arguments: { browser: 'chromium' }, metadata: {} })
              )
              assert.exists(testEvent.content.metrics[DD_HOST_CPU_COUNT])
            })

            stepEvents.forEach(stepEvent => {
              assert.equal(stepEvent.content.name, 'playwright.step')
              assert.property(stepEvent.content.meta, 'playwright.step')
            })
            const annotatedTest = testEvents.find(test =>
              test.content.resource.endsWith('should work with annotated tests')
            )

            assert.propertyVal(annotatedTest.content.meta, 'test.memory.usage', 'low')
            assert.propertyVal(annotatedTest.content.metrics, 'test.memory.allocations', 16)
            assert.notProperty(annotatedTest.content.meta, 'test.invalid')
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
                DD_SERVICE: undefined
              },
              stdio: 'pipe'
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
        assert.includeMembers(testEvents.map(test => test.content.resource), [
          'playwright-tests-ts/one-test.js.playwright should work with passing tests',
          'playwright-tests-ts/one-test.js.playwright should work with skipped tests'
        ])
        assert.include(testOutput, '1 passed')
        assert.include(testOutput, '1 skipped')
        assert.notInclude(testOutput, 'TypeError')
      }, 25000).then(() => done()).catch(done)

      childProcess = exec(
        'node ./node_modules/typescript/bin/tsc' +
        '&& ./node_modules/.bin/playwright test -c ci-visibility/playwright-tests-ts-out',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            PW_RUNNER_DEBUG: '1'
          },
          stdio: 'inherit'
        }
      )
      childProcess.stdout.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', chunk => {
        testOutput += chunk.toString()
      })
    })

    it('works when before all fails and step durations are negative', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSuiteEvent = events.find(event => event.type === 'test_suite_end').content
        const testSessionEvent = events.find(event => event.type === 'test_session_end').content

        assert.propertyVal(testSuiteEvent.meta, TEST_STATUS, 'fail')
        assert.propertyVal(testSessionEvent.meta, TEST_STATUS, 'fail')
        assert.exists(testSuiteEvent.meta[ERROR_MESSAGE])
        assert.include(testSessionEvent.meta[ERROR_MESSAGE], 'Test suites failed: 1')
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            TEST_DIR: './ci-visibility/playwright-tests-error',
            TEST_TIMEOUT: 3000
          },
          stdio: 'pipe'
        }
      )
    })

    context('early flake detection', () => {
      it('retries new tests', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests'
              ],
              'skipped-suite-test.js': [
                'should work with fixme root'
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root'
              ]
            }
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            newTests.forEach(test => {
              assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

            assert.equal(retriedTests.length, NUM_RETRIES_EFD)

            retriedTests.forEach(test => {
              assert.propertyVal(test.meta, TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES.efd)
            })

            // all but one has been retried
            assert.equal(retriedTests.length, newTests.length - 1)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests'
              ],
              'skipped-suite-test.js': [
                'should work with fixme root'
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root'
              ]
            }
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
              assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false'
            },
            stdio: 'pipe'
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
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
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
                'highest-level-describe  leading and trailing spaces    should work with annotated tests'
              ],
              'skipped-suite-test.js': [
                'should work with fixme root'
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root'
              ]
            }
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
            assert.equal(newTests.length, 2)
            newTests.forEach(test => {
              assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

            assert.equal(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
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
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: true
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({})

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.equal(tests.length, 7)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.equal(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
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
              '5s': NUM_RETRIES_EFD
            }
          },
          known_tests_enabled: false
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests'
              ],
              'skipped-suite-test.js': [
                'should work with fixme root'
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root'
              ]
            }
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            newTests.forEach(test => {
              assert.notProperty(test.meta, TEST_IS_NEW)
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })
    })

    it('does not crash when maxFailures=1 and there is an error', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testEvents = events.filter(event => event.type === 'test')

        assert.includeMembers(testEvents.map(test => test.content.resource), [
          'failing-test-and-another-test.js.should work with failing tests',
          'failing-test-and-another-test.js.does not crash afterwards'
        ])
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            MAX_FAILURES: 1,
            TEST_DIR: './ci-visibility/playwright-tests-max-failures'
          },
          stdio: 'pipe'
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
            enabled: false
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.equal(tests.length, 3)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 2)

            const failedRetryTests = failedTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )
            assert.equal(failedRetryTests.length, 1) // the first one is not a retry

            const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
            assert.equal(passedTests.length, 1)
            assert.equal(passedTests[0].meta[TEST_IS_RETRY], 'true')
            assert.equal(passedTests[0].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry'
            },
            stdio: 'pipe'
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
            enabled: false
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.equal(tests.length, 1)
            assert.equal(tests.filter(
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
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry'
            },
            stdio: 'pipe'
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
            enabled: false
          }
        })

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.equal(tests.length, 2)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.equal(failedTests.length, 2)

            const failedRetryTests = failedTests.filter(
              test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            )
            assert.equal(failedRetryTests.length, 1)
          }, 30000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-automatic-retry',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 1
            },
            stdio: 'pipe'
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
          assert.notEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.equal(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        })

      childProcess = exec(
        '../../node_modules/.bin/playwright test',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            PW_RUNNER_DEBUG: '1',
            TEST_DIR: '.'
          },
          stdio: 'inherit'
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    context('known tests without early flake detection', () => {
      it('detects new tests without retrying them', (done) => {
        receiver.setSettings({
          known_tests_enabled: true
        })

        receiver.setKnownTests(
          {
            playwright: {
              'landing-page-test.js': [
                // it will be considered new
                // 'highest-level-describe  leading and trailing spaces    should work with passing tests',
                'highest-level-describe  leading and trailing spaces    should work with skipped tests',
                'highest-level-describe  leading and trailing spaces    should work with fixme',
                'highest-level-describe  leading and trailing spaces    should work with annotated tests'
              ],
              'skipped-suite-test.js': [
                'should work with fixme root'
              ],
              'todo-list-page-test.js': [
                'playwright should work with failing tests',
                'should work with fixme root'
              ]
            }
          }
        )

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const newTests = tests.filter(test =>
              test.resource.endsWith('should work with passing tests')
            )
            // new tests detected but no retries
            newTests.forEach(test => {
              assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
            })

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`
            },
            stdio: 'pipe'
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
            assert.equal(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        })

      childProcess = exec(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            DD_SERVICE: 'my-service'
          },
          stdio: 'pipe'
        }
      )

      childProcess.on('exit', () => {
        receiverPromise.then(() => done()).catch(done)
      })
    })

    context('test management', () => {
      context('attempt to fix', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'attempt-to-fix-test.js': {
                  tests: {
                    'attempt to fix should attempt to fix failed test': {
                      properties: {
                        attempt_to_fix: true
                      }
                    }
                  }
                }
              }
            }
          })
        })

        const getTestAssertions = ({
          isAttemptingToFix,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled,
          isQuarantined
        }) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const testSession = events.find(event => event.type === 'test_session_end').content

              if (isAttemptingToFix) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              const attemptedToFixTests = tests.filter(
                test => test.meta[TEST_NAME] === 'attempt to fix should attempt to fix failed test'
              )

              if (isAttemptingToFix) {
                assert.equal(attemptedToFixTests.length, 4)
              } else {
                assert.equal(attemptedToFixTests.length, 1)
              }

              if (isDisabled) {
                const numDisabledTests = attemptedToFixTests.filter(test =>
                  test.meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'
                ).length
                assert.equal(numDisabledTests, attemptedToFixTests.length)
              }

              if (isQuarantined) {
                const numQuarantinedTests = attemptedToFixTests.filter(test =>
                  test.meta[TEST_MANAGEMENT_IS_QUARANTINED] === 'true'
                ).length
                assert.equal(numQuarantinedTests, attemptedToFixTests.length)
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

              if (isAttemptingToFix) {
                assert.equal(countAttemptToFixTests, attemptedToFixTests.length)
                assert.equal(countRetriedAttemptToFixTests, attemptedToFixTests.length - 1)
                if (shouldAlwaysPass) {
                  assert.equal(testsMarkedAsFailedAllRetries, 0)
                  assert.equal(testsMarkedAsFailed, 0)
                  assert.equal(testsMarkedAsPassedAllRetries, 1)
                } else if (shouldFailSometimes) {
                  assert.equal(testsMarkedAsFailedAllRetries, 0)
                  assert.equal(testsMarkedAsFailed, 1)
                  assert.equal(testsMarkedAsPassedAllRetries, 0)
                } else { // always fail
                  assert.equal(testsMarkedAsFailedAllRetries, 1)
                  assert.equal(testsMarkedAsFailed, 1)
                  assert.equal(testsMarkedAsPassedAllRetries, 0)
                }
              } else {
                assert.equal(countAttemptToFixTests, 0)
                assert.equal(countRetriedAttemptToFixTests, 0)
                assert.equal(testsMarkedAsFailedAllRetries, 0)
                assert.equal(testsMarkedAsPassedAllRetries, 0)
              }
            })

        const runAttemptToFixTest = (done, {
          isAttemptingToFix,
          isQuarantined,
          extraEnvVars,
          shouldAlwaysPass,
          shouldFailSometimes,
          isDisabled
        } = {}) => {
          const testAssertionsPromise = getTestAssertions({
            isAttemptingToFix,
            shouldAlwaysPass,
            shouldFailSometimes,
            isDisabled,
            isQuarantined
          })

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js attempt-to-fix-test.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...(shouldAlwaysPass ? { SHOULD_ALWAYS_PASS: '1' } : {}),
                ...(shouldFailSometimes ? { SHOULD_FAIL_SOMETIMES: '1' } : {}),
                ...extraEnvVars
              },
              stdio: 'pipe'
            }
          )

          childProcess.on('exit', (exitCode) => {
            testAssertionsPromise.then(() => {
              if (isQuarantined || isDisabled || shouldAlwaysPass) {
                // even though a test fails, the exit code is 0 because the test is quarantined
                assert.equal(exitCode, 0)
              } else {
                assert.equal(exitCode, 1)
              }
              done()
            }).catch(done)
          })
        }

        it('can attempt to fix and mark last attempt as failed if every attempt fails', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(done, { isAttemptingToFix: true })
        })

        it('can attempt to fix and mark last attempt as passed if every attempt passes', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(done, { isAttemptingToFix: true, shouldAlwaysPass: true })
        })

        it('can attempt to fix and not mark last attempt if attempts both pass and fail', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(done, { isAttemptingToFix: true, shouldFailSometimes: true })
        })

        it('does not attempt to fix tests if test management is not enabled', (done) => {
          receiver.setSettings({ test_management: { enabled: false, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(done)
        })

        it('does not enable attempt to fix tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })

          runAttemptToFixTest(done, { extraEnvVars: { DD_TEST_MANAGEMENT_ENABLED: '0' } })
        })

        it('does not fail retry if a test is quarantined', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'attempt-to-fix-test.js': {
                  tests: {
                    'attempt to fix should attempt to fix failed test': {
                      properties: {
                        attempt_to_fix: true,
                        quarantined: true
                      }
                    }
                  }
                }
              }
            }
          })

          runAttemptToFixTest(done, { isAttemptingToFix: true, isQuarantined: true })
        })

        it('does not fail retry if a test is disabled', (done) => {
          receiver.setSettings({ test_management: { enabled: true, attempt_to_fix_retries: 3 } })
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'attempt-to-fix-test.js': {
                  tests: {
                    'attempt to fix should attempt to fix failed test': {
                      properties: {
                        attempt_to_fix: true,
                        disabled: true
                      }
                    }
                  }
                }
              }
            }
          })

          runAttemptToFixTest(done, { isAttemptingToFix: true, isDisabled: true })
        })
      })

      context('disabled', () => {
        beforeEach(() => {
          receiver.setTestManagementTests({
            playwright: {
              suites: {
                'disabled-test.js': {
                  tests: {
                    'disable should disable test': {
                      properties: {
                        disabled: true
                      }
                    }
                  }
                }
              }
            }
          })
        })

        const getTestAssertions = (isDisabling) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              if (isDisabling) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              const skippedTest = events.find(event => event.type === 'test').content

              if (isDisabling) {
                assert.equal(skippedTest.meta[TEST_STATUS], 'skip')
                assert.propertyVal(skippedTest.meta, TEST_MANAGEMENT_IS_DISABLED, 'true')
              } else {
                assert.equal(skippedTest.meta[TEST_STATUS], 'fail')
                assert.notProperty(skippedTest.meta, TEST_MANAGEMENT_IS_DISABLED)
              }
            })

        const runDisableTest = (done, isDisabling, extraEnvVars) => {
          const testAssertionsPromise = getTestAssertions(isDisabling)

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js disabled-test.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars
              },
              stdio: 'pipe'
            }
          )

          childProcess.on('exit', (exitCode) => {
            testAssertionsPromise.then(() => {
              if (isDisabling) {
                assert.equal(exitCode, 0)
              } else {
                assert.equal(exitCode, 1)
              }
              done()
            }).catch(done)
          })
        }

        it('can disable tests', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runDisableTest(done, true)
        })

        it('fails if disable is not enabled', (done) => {
          receiver.setSettings({ test_management: { enabled: false } })

          runDisableTest(done, false)
        })

        it('does not enable disable tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runDisableTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
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
                        quarantined: true
                      }
                    }
                  }
                }
              }
            }
          })
        })

        const getTestAssertions = (isQuarantining) =>
          receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content
              if (isQuarantining) {
                assert.propertyVal(testSession.meta, TEST_MANAGEMENT_ENABLED, 'true')
              } else {
                assert.notProperty(testSession.meta, TEST_MANAGEMENT_ENABLED)
              }

              const failedTest = events.find(event => event.type === 'test').content

              if (isQuarantining) {
                // TODO: manage to run the test
                assert.equal(failedTest.meta[TEST_STATUS], 'skip')
                assert.propertyVal(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED, 'true')
              } else {
                assert.equal(failedTest.meta[TEST_STATUS], 'fail')
                assert.notProperty(failedTest.meta, TEST_MANAGEMENT_IS_QUARANTINED)
              }
            })

        const runQuarantineTest = (done, isQuarantining, extraEnvVars) => {
          const testAssertionsPromise = getTestAssertions(isQuarantining)

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js quarantine-test.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${webAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-management',
                ...extraEnvVars
              },
              stdio: 'pipe'
            }
          )

          childProcess.on('exit', (exitCode) => {
            testAssertionsPromise.then(() => {
              if (isQuarantining) {
                assert.equal(exitCode, 0)
              } else {
                assert.equal(exitCode, 1)
              }
              done()
            }).catch(done)
          })
        }

        it('can quarantine tests', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runQuarantineTest(done, true)
        })

        it('fails if quarantine is not enabled', (done) => {
          receiver.setSettings({ test_management: { enabled: false } })

          runQuarantineTest(done, false)
        })

        it('does not enable quarantine tests if DD_TEST_MANAGEMENT_ENABLED is set to false', (done) => {
          receiver.setSettings({ test_management: { enabled: true } })

          runQuarantineTest(done, false, { DD_TEST_MANAGEMENT_ENABLED: '0' })
        })
      })
    })

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.isNotEmpty(metadataDicts)
            metadataDicts.forEach(metadata => {
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
              assert.equal(metadata.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
              assert.equal(metadata.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '4')
              // capabilities logic does not overwrite test session name
              assert.equal(metadata.test[TEST_SESSION_NAME], 'my-test-session-name')
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
              DD_TEST_SESSION_NAME: 'my-test-session-name'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          eventsPromise.then(() => {
            done()
          }).catch(done)
        })
      })
    })

    context('active test span', () => {
      it('can grab the test span and add tags', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const test = events.find(event => event.type === 'test').content

            assert.equal(test.meta['test.custom_tag'], 'this is custom')
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js active-test-span-tags-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-active-test-span'
            },
            stdio: 'pipe'
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

            assert.exists(customSpan)
            assert.equal(customSpan.meta['test.really_custom_tag'], 'this is really custom')

            // custom span is children of active test span
            assert.equal(customSpan.trace_id.toString(), test.trace_id.toString())
            assert.equal(customSpan.parent_id.toString(), test.span_id.toString())
          })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js active-test-span-custom-span-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-active-test-span'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          receiverPromise.then(() => done()).catch(done)
        })
      })
    })

    context('correlation between tests and RUM sessions', () => {
      const getTestAssertions = ({ isRedirecting }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const playwrightTest = events.find(event => event.type === 'test').content
            if (isRedirecting) {
              assert.notProperty(playwrightTest.meta, TEST_IS_RUM_ACTIVE)
              assert.notProperty(playwrightTest.meta, TEST_BROWSER_VERSION)
            } else {
              assert.property(playwrightTest.meta, TEST_IS_RUM_ACTIVE, 'true')
              assert.property(playwrightTest.meta, TEST_BROWSER_VERSION)
            }
            assert.include(playwrightTest.meta, {
              [TEST_BROWSER_NAME]: 'chromium',
              [TEST_TYPE]: 'browser'
            })
          })

      const runTest = (done, { isRedirecting }, extraEnvVars) => {
        const testAssertionsPromise = getTestAssertions({ isRedirecting })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js active-test-span-rum-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${isRedirecting ? webPortWithRedirect : webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-rum',
              ...extraEnvVars
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          testAssertionsPromise.then(() => done()).catch(done)
        })
      }

      it('can correlate tests and RUM sessions', (done) => {
        runTest(done, { isRedirecting: false })
      })

      it('do not crash when redirecting and RUM sessions are not active', (done) => {
        runTest(done, { isRedirecting: true })
      })
    })

    context('run session status', () => {
      it('session status is not changed if it fails before running any test', (done) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.equal(testSession.meta[TEST_STATUS], 'fail')
          })

        receiver.setSettings({ test_management: { enabled: true } })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js exit-code-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-exit-code'
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', (exitCode) => {
          assert.equal(exitCode, 1)
          receiverPromise.then(() => done()).catch(done)
        })
      })
    })

    context('impacted tests', () => {
      const NUM_RETRIES = 3
      let baseCommitSha = null
      let commitHeadSha = null
      let eventPath = null
      let testConfig = null

      function promiseExec (command) {
        return new Promise((resolve) => {
          const child = exec(command, { cwd })
          let data = ''
          child.stdout.on('data', chunk => { data += chunk })
          child.stdout.on('end', () => resolve(data.trim()))
        })
      }

      beforeEach(() => {
        const eventContent = {
          pull_request: {
            base: {
              sha: baseCommitSha,
              ref: 'master'
            },
            head: {
              sha: commitHeadSha,
              ref: 'master'
            }
          }
        }
        eventPath = path.join(cwd, 'event.json')
        fs.writeFileSync(eventPath, JSON.stringify(eventContent, null, 2))

        testConfig = {
          GITHUB_ACTIONS: true,
          GITHUB_BASE_REF: 'master',
          GITHUB_HEAD_REF: 'feature-branch',
          GITHUB_EVENT_PATH: eventPath
        }
      })

      // Add git setup before running impacted tests
      before(async function () {
        // Create initial test file on main
        const testDir = path.join(cwd, 'ci-visibility/playwright-tests-impacted-tests')
        await exec(`mkdir -p ${testDir}`, { cwd })
        const testContent = `
const { test, expect } = require('@playwright/test')

test.beforeEach(async ({ page }) => {
await page.goto(process.env.PW_BASE_URL)
})

test.describe('impacted test', () => {
test('should be impacted', async ({ page }) => {
  await expect(page.locator('.hello-world')).toHaveText([
    'Hello World'
  ])
})
})
`
        fs.writeFileSync(path.join(testDir, 'impacted-test.js'), testContent)

        await promiseExec('git add ci-visibility/playwright-tests-impacted-tests/impacted-test.js')
        await promiseExec('git commit -m "add impacted-test.js"')
        // Get base commit SHA from main after creating the file
        baseCommitSha = await promiseExec('git rev-parse HEAD')

        await promiseExec('git checkout -b feature-branch')
        const modifiedTestContent = `
const { test, expect } = require('@playwright/test')

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
`
        fs.writeFileSync(path.join(testDir, 'impacted-test.js'), modifiedTestContent)
        await promiseExec('git add ci-visibility/playwright-tests-impacted-tests/impacted-test.js')
        await promiseExec('git commit -m "modify impacted-test.js"')
        commitHeadSha = await promiseExec('git rev-parse HEAD')
      })

      // Clean up git branches and temp files after impacted tests
      after(async () => {
        await promiseExec('git checkout main')
        await promiseExec('git branch -D feature-branch')
        if (fs.existsSync(eventPath)) {
          fs.unlinkSync(eventPath)
        }
      })

      const getTestAssertions = ({ isImpacting, isEfd }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfd) {
              assert.propertyVal(testSession.meta, TEST_EARLY_FLAKE_ENABLED, 'true')
            } else {
              assert.notProperty(testSession.meta, TEST_EARLY_FLAKE_ENABLED)
            }

            const resourceNames = tests.map(span => span.resource)

            assert.includeMembers(resourceNames,
              [
                'impacted-test.js.impacted test should be impacted'
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/playwright-tests-impacted-tests/impacted-test.js' &&
              test.meta[TEST_NAME] === 'impacted test should be impacted')

            if (isEfd) {
              assert.equal(impactedTests.length, NUM_RETRIES + 1) // Retries + original test
            } else {
              assert.equal(impactedTests.length, 1)
            }

            if (isImpacting) {
              impactedTests.forEach(test => {
                assert.propertyVal(test.meta, TEST_IS_MODIFIED, 'true')
              })
            } else {
              impactedTests.forEach(test => {
                assert.notProperty(test.meta, TEST_IS_MODIFIED)
              })
            }

            if (isEfd) {
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.equal(retriedTests.length, NUM_RETRIES)
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
              assert.equal(retriedTestNew, 0)
              assert.equal(retriedTestsWithReason, NUM_RETRIES)
            }
          })

      const runImpactedTest = (
        done,
        { isImpacting, isEfd = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isImpacting, isEfd })

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js impacted-test.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-impacted-tests',
              ...testConfig,
              ...extraEnvVars
            },
            stdio: 'pipe'
          }
        )

        childProcess.on('exit', () => {
          testAssertionsPromise.then(done).catch(done)
        })
      }

      it('can impacted tests', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })

        runImpactedTest(done, { isImpacting: true })
      })

      it('does not impact tests if disabled', (done) => {
        receiver.setSettings({ impacted_tests_enabled: false })

        runImpactedTest(done, { isImpacting: false })
      })

      it('does not impact tests DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is set to false', (done) => {
        receiver.setSettings({ impacted_tests_enabled: false })

        runImpactedTest(done,
          { isImpacting: false },
          { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
        )
      })

      it('can impact tests with no base sha', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })
        const eventContent = {
          pull_request: {
            base: {
              sha: '',
              ref: 'master'
            },
            head: {
              sha: commitHeadSha,
              ref: 'master'
            }
          }
        }
        eventPath = path.join(cwd, 'event.json')
        fs.writeFileSync(eventPath, JSON.stringify(eventContent, null, 2))

        runImpactedTest(done, { isImpacting: true })
      })

      it('can impact tests with no head sha', (done) => {
        receiver.setSettings({ impacted_tests_enabled: true })
        const eventContent = {
          pull_request: {
            base: {
              sha: baseCommitSha,
              ref: 'master'
            },
            head: {
              sha: '',
              ref: 'master'
            }
          }
        }
        eventPath = path.join(cwd, 'event.json')
        fs.writeFileSync(eventPath, JSON.stringify(eventContent, null, 2))

        runImpactedTest(done, { isImpacting: true })
      })

      it('can impact tests in and activate EFD if modified (no known tests)', (done) => {
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES
            }
          },
          known_tests_enabled: true
        })
        runImpactedTest(done,
          { isImpacting: true, isEfd: true }
        )
      })

      it('can impact tests in and activate EFD if modified (with known tests)', (done) => {
        receiver.setSettings({
          impacted_tests_enabled: true,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES
            }
          },
          known_tests_enabled: true
        })
        receiver.setKnownTests({ playwright: { 'impacted-test.js': ['impacted test should be impacted'] } })
        runImpactedTest(done,
          { isImpacting: true, isEfd: true }
        )
      })
    })
  })
})
