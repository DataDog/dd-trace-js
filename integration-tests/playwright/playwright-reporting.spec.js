'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
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
const {
  TEST_STATUS,
  TEST_SOURCE_START,
  TEST_TYPE,
  TEST_SOURCE_FILE,
  TEST_PARAMETERS,
  TEST_BROWSER_NAME,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_NAME,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR } = require('../../version')

const { PLAYWRIGHT_VERSION } = process.env

const latest = 'latest'
const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const versions = [oldest, latest]

versions.forEach((version) => {
  if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
  if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

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
        const expectedResources = [
          'playwright-tests-ts/one-test.js.playwright should work with passing tests',
          'playwright-tests-ts/one-test.js.playwright should work with skipped tests',
        ]
        const actualResources = testEvents.map(test => test.content.resource).sort()
        for (const expectedResource of expectedResources) {
          assert.ok(
            actualResources.includes(expectedResource),
            `expected ${expectedResource}, got events: ${JSON.stringify(events.map(event => ({
              type: event.type,
              resource: event.content.resource,
              sourceFile: event.content.meta?.[TEST_SOURCE_FILE],
              sourceStart: event.content.metrics?.[TEST_SOURCE_START],
              status: event.content.meta?.[TEST_STATUS],
              error: event.content.meta?.[ERROR_MESSAGE],
            })), null, 2)}\nPlaywright output:\n${testOutput}`
          )
        }
        assert.deepStrictEqual(
          testEvents
            .map(test => ({
              resource: test.content.resource,
              sourceFile: test.content.meta[TEST_SOURCE_FILE],
              sourceStart: test.content.metrics[TEST_SOURCE_START],
            }))
            .sort((left, right) => left.resource.localeCompare(right.resource)),
          [
            {
              resource: 'playwright-tests-ts/one-test.js.playwright should work with passing tests',
              sourceFile: 'ci-visibility/playwright-tests-ts/one-test.ts',
              sourceStart: 9,
            },
            {
              resource: 'playwright-tests-ts/one-test.js.playwright should work with skipped tests',
              sourceFile: 'ci-visibility/playwright-tests-ts/one-test.ts',
              sourceStart: 14,
            },
          ]
        )
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
  })
})
