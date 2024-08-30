'use strict'

const { exec, execSync } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_SOURCE_START,
  TEST_TYPE,
  TEST_SOURCE_FILE,
  TEST_CONFIGURATION_BROWSER_NAME,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME
} = require('../../packages/dd-trace/src/plugins/util/test')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')

const NUM_RETRIES_EFD = 3

const versions = ['1.18.0', 'latest']

versions.forEach((version) => {
  describe(`playwright@${version}`, () => {
    let sandbox, cwd, receiver, childProcess, webAppPort

    before(async function () {
      // bump from 30 to 60 seconds because playwright dependencies are heavy
      this.timeout(60000)
      sandbox = await createSandbox([`@playwright/test@${version}`, 'typescript'], true)
      cwd = sandbox.folder
      // install necessary browser
      const { NODE_OPTIONS, ...restOfEnv } = process.env
      execSync('npx playwright install', { cwd, env: restOfEnv })
      webAppPort = await getPort()
      webAppServer.listen(webAppPort)
    })

    after(async () => {
      await sandbox.remove()
      await new Promise(resolve => webAppServer.close(resolve))
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
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const stepEvents = events.filter(event => event.type === 'span')

            assert.equal(testSessionEvent.content.meta[TEST_SESSION_NAME], 'my-test-session')
            assert.include(testSessionEvent.content.resource, 'test_session.playwright test')
            assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.equal(testModuleEvent.content.meta[TEST_SESSION_NAME], 'my-test-session')
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
              assert.equal(testSuiteEvent.content.meta[TEST_SESSION_NAME], 'my-test-session')
              if (testSuiteEvent.content.meta[TEST_STATUS] === 'fail') {
                assert.exists(testSuiteEvent.content.meta[ERROR_MESSAGE])
              }
            })

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'landing-page-test.js.should work with passing tests',
              'landing-page-test.js.should work with skipped tests',
              'landing-page-test.js.should work with fixme',
              'landing-page-test.js.should work with annotated tests',
              'todo-list-page-test.js.should work with failing tests',
              'todo-list-page-test.js.should work with fixme root'
            ])

            assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip'
            ])

            testEvents.forEach(testEvent => {
              assert.equal(testEvent.content.meta[TEST_SESSION_NAME], 'my-test-session')
              assert.exists(testEvent.content.metrics[TEST_SOURCE_START])
              assert.equal(
                testEvent.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/playwright-tests/'), true
              )
              // Can read DD_TAGS
              assert.propertyVal(testEvent.content.meta, 'test.customtag', 'customvalue')
              assert.propertyVal(testEvent.content.meta, 'test.customtag2', 'customvalue2')
              // Adds the browser used
              assert.propertyVal(testEvent.content.meta, TEST_CONFIGURATION_BROWSER_NAME, 'chromium')
            })

            stepEvents.forEach(stepEvent => {
              assert.equal(stepEvent.content.name, 'playwright.step')
              assert.property(stepEvent.content.meta, 'playwright.step')
            })
            const annotatedTest = testEvents.find(test =>
              test.content.resource === 'landing-page-test.js.should work with annotated tests'
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
                DD_SESSION_NAME: 'my-test-session'
              },
              stdio: 'pipe'
            }
          )
        })
      })
    })

    it('works when tests are compiled to a different location', (done) => {
      let testOutput = ''

      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event => event.type === 'test')
        assert.includeMembers(testEvents.map(test => test.content.resource), [
          'playwright-tests-ts/one-test.js.should work with passing tests',
          'playwright-tests-ts/one-test.js.should work with skipped tests'
        ])
        assert.include(testOutput, '1 passed')
        assert.include(testOutput, '1 skipped')
        assert.notInclude(testOutput, 'TypeError')
      }).then(() => done()).catch(done)

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

    if (version === 'latest') {
      context('early flake detection', () => {
        it('retries new tests', (done) => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          receiver.setKnownTests(
            {
              playwright: {
                'landing-page-test.js': [
                  // 'should work with passing tests', // it will be considered new
                  'should work with skipped tests',
                  'should work with fixme',
                  'should work with annotated tests'
                ],
                'skipped-suite-test.js': [
                  'should work with fixme root'
                ],
                'todo-list-page-test.js': [
                  'should work with failing tests',
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
                test.resource ===
                  'landing-page-test.js.should work with passing tests'
              )
              newTests.forEach(test => {
                assert.propertyVal(test.meta, TEST_IS_NEW, 'true')
              })

              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.equal(retriedTests.length, NUM_RETRIES_EFD)

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
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          receiver.setKnownTests(
            {
              playwright: {
                'landing-page-test.js': [
                  // 'should work with passing tests', // it will be considered new
                  'should work with skipped tests',
                  'should work with fixme',
                  'should work with annotated tests'
                ],
                'skipped-suite-test.js': [
                  'should work with fixme root'
                ],
                'todo-list-page-test.js': [
                  'should work with failing tests',
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
                test.resource ===
                  'landing-page-test.js.should work with passing tests'
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
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
          })

          receiver.setKnownTests(
            {
              playwright: {
                'landing-page-test.js': [
                  'should work with passing tests',
                  // 'should work with skipped tests', // new but not retried because it's skipped
                  // 'should work with fixme', // new but not retried because it's skipped
                  'should work with annotated tests'
                ],
                'skipped-suite-test.js': [
                  'should work with fixme root'
                ],
                'todo-list-page-test.js': [
                  'should work with failing tests',
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
                test.resource ===
                  'landing-page-test.js.should work with skipped tests' ||
                test.resource === 'landing-page-test.js.should work with fixme'
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
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD
              }
            }
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
      })
    }

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

            const failedRetryTests = failedTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.equal(failedRetryTests.length, 1) // the first one is not a retry

            const passedTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
            assert.equal(passedTests.length, 1)
            assert.equal(passedTests[0].meta[TEST_IS_RETRY], 'true')
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
            assert.equal(tests.filter((test) => test.meta[TEST_IS_RETRY]).length, 0)
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

            const failedRetryTests = failedTests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
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
          // The test is in a subproject
          assert.notEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
          assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
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
  })
})
