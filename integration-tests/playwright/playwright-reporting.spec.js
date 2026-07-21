'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { inspect } = require('node:util')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  installPlaywrightChromium,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
  createParallelIt,
} = require('../helpers')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_SOURCE_START,
  TEST_TYPE,
  TEST_SOURCE_FILE,
  TEST_PARAMETERS,
  TEST_BROWSER_NAME,
  TEST_FRAMEWORK_VERSION,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_COMMAND,
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
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')

const { PLAYWRIGHT_VERSION } = process.env

const latest = 'latest'
const { oldest } = require('./versions')
const versions = [oldest, latest]
const REQUEST_ERROR_TAG_TEST_DIR = './ci-visibility/playwright-tests-request-error-tag'
const SCREENSHOT_CAPTURE_DISABLED_WARNING =
  'DD_TEST_FAILURE_SCREENSHOTS_ENABLED is true, but Playwright screenshot capture is disabled.'
const SCREENSHOT_UPLOAD_UNSUPPORTED_WARNING =
  'DD_TEST_FAILURE_SCREENSHOTS_ENABLED is true, but Playwright screenshot upload is not supported'

function assertRequestErrorTag (events, tag) {
  const eventTypes = ['test_session_end', 'test_module_end', 'test_suite_end', 'test']
  for (const eventType of eventTypes) {
    const event = events.find(event => event.type === eventType)
    assert.ok(event, `should have ${eventType} event`)
    assert.strictEqual(event.content.meta[tag], 'true', `${eventType} should have ${tag} tag`)
  }
}

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

    async function runRequestErrorTagTest (receiver, run, envVars, tag) {
      const proc = run(
        './node_modules/.bin/playwright test -c playwright.config.js',
        {
          cwd,
          env: {
            ...envVars,
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            DD_TEST_SESSION_NAME: 'my-test-session',
            TEST_DIR: REQUEST_ERROR_TAG_TEST_DIR,
          },
        }
      )
      const eventsPromise = receiver
        .gatherPayloadsUntilChildExit(proc, ({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          assertRequestErrorTag(events, tag)
        })
      const [[exitCode]] = await Promise.all([once(proc, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, 0)
    }

    const reportMethods = ['agentless', 'evp proxy']

    reportMethods.forEach((reportMethod) => {
      context(`reporting via ${reportMethod}`, () => {
        context('error tags', () => {
          it(
            'tags session and children with _dd.ci.library_configuration_error.settings when settings fail 4xx',
            async (receiver, run) => {
              const envVars = reportMethod === 'agentless'
                ? getCiVisAgentlessConfig(receiver.port)
                : getCiVisEvpProxyConfig(receiver.port)
              receiver.setSettingsResponseCode(404)
              await runRequestErrorTagTest(
                receiver,
                run,
                envVars,
                DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS
              )
            })

          // No skippable_tests test: playwright does not request skippable suites (TIA unsupported).

          contextNewVersions('new version requests', () => {
            it(
              'tags session and children with _dd.ci.library_configuration_error.known_tests ' +
              'when request fails 4xx',
              async (receiver, run) => {
                const envVars = reportMethod === 'agentless'
                  ? getCiVisAgentlessConfig(receiver.port)
                  : getCiVisEvpProxyConfig(receiver.port)
                receiver.setSettings({ known_tests_enabled: true })
                receiver.setKnownTestsResponseCode(404)
                await runRequestErrorTagTest(
                  receiver,
                  run,
                  envVars,
                  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS
                )
              })

            it(
              'tags session and children with _dd.ci.library_configuration_error.test_management_tests ' +
              'when request fail',
              async (receiver, run) => {
                const envVars = reportMethod === 'agentless'
                  ? getCiVisAgentlessConfig(receiver.port)
                  : getCiVisEvpProxyConfig(receiver.port)
                receiver.setSettings({ test_management: { enabled: true } })
                receiver.setTestManagementTestsResponseCode(404)
                await runRequestErrorTagTest(
                  receiver,
                  run,
                  envVars,
                  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS
                )
              })
          })
        })

        it('can run and report tests', async (receiver, run) => {
          const envVars = reportMethod === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port)
            : getCiVisEvpProxyConfig(receiver.port)
          const reportUrl = reportMethod === 'agentless'
            ? '/api/v2/citestcycle'
            : '/evp_proxy/v2/api/v2/citestcycle'

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === reportUrl, payloads => {
              const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

              metadataDicts.forEach(metadata => {
                assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
              })

              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSessionEvent = events.find(event => event.type === 'test_session_end')
              const testModuleEvent = events.find(event => event.type === 'test_module_end')
              const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
              const testEvents = events.filter(event => event.type === 'test')
              const stepEvents = events.filter(event => event.type === 'span')

              assert.ok(
                testSessionEvent.content.resource.includes('test_session.playwright test'),
                `Got: ${inspect(testSessionEvent.content.resource)}`
              )
              assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
              assert.ok(
                testModuleEvent.content.resource.includes('test_module.playwright test'),
                `Got: ${inspect(testModuleEvent.content.resource)}`
              )
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
                assert.match(testSuiteEvent.content.meta[TEST_SOURCE_FILE], /-test\.js$/)
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
                assert.ok(testEvent.content.meta[TEST_FRAMEWORK_VERSION])
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
                assert.ok(
                  Object.hasOwn(stepEvent.content.meta, 'playwright.step'),
                  `Available keys: ${inspect(Object.keys(stepEvent.content.meta))}`
                )
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
            })

          const proc = run(
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
          await Promise.all([eventsPromise, once(proc, 'exit')])
        })
      })
    })

    contextNewVersions('failure screenshots', () => {
      const screenshotModes = ['on', 'only-on-failure']
      if (version === latest || satisfies(version, '>=1.49.0')) {
        screenshotModes.push('on-first-failure')
      }
      let screenshotRunId = 0

      function runWithFailureScreenshots (
        receiver,
        run,
        screenshotMode = 'only-on-failure',
        isScreenshotUploadEnabled = true,
        testOptimizationConfig = getCiVisAgentlessConfig(receiver.port)
      ) {
        let testOutput = ''
        const proc = run(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...testOptimizationConfig,
              PW_BASE_URL: `http://localhost:${webAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-screenshot',
              PLAYWRIGHT_FAILURE_SCREENSHOT_MODE: screenshotMode,
              PLAYWRIGHT_OUTPUT_DIR: `./test-results-failure-screenshots-${++screenshotRunId}`,
              DD_TEST_FAILURE_SCREENSHOTS_ENABLED: isScreenshotUploadEnabled ? 'true' : undefined,
              DD_TRACE_DEBUG: 'true',
              DD_TRACE_LOG_LEVEL: 'warn',
            },
          }
        )
        proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })
        return { proc, getTestOutput: () => testOutput }
      }

      for (const screenshotMode of screenshotModes) {
        it(`uploads only automatic failure screenshots with screenshot: '${screenshotMode}'`, async (receiver, run) => {
          const { proc, getTestOutput } = runWithFailureScreenshots(receiver, run, screenshotMode)
          const payloadsPromise = receiver
            .gatherPayloadsUntilChildExit(
              proc,
              ({ url }) => url.startsWith('/api/v2/ci/test-runs/') || url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const testOutput = getTestOutput()
                const mediaPayloads = payloads.filter(({ url }) => url.startsWith('/api/v2/ci/test-runs/'))
                const failedTest = payloads
                  .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
                  .flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test')
                  .find(event => event.content.meta[TEST_NAME] === 'uploads only the automatic failure screenshot')

                assert.ok(failedTest, `failed test event should be reported\n${testOutput}`)
                assert.strictEqual(failedTest.content.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
                assert.strictEqual(failedTest.content.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
                assert.strictEqual(
                  mediaPayloads.length,
                  1,
                  `only the automatic screenshot should upload\n${testOutput}`
                )

                const [screenshotPayload] = mediaPayloads
                const expectedTraceId = failedTest.content.trace_id.toString()
                assert.strictEqual(screenshotPayload.media.traceId, expectedTraceId)
                assert.strictEqual(screenshotPayload.media.contentType, 'image/png')
                assert.strictEqual(screenshotPayload.headers['dd-api-key'], '1')
                assert.strictEqual(
                  screenshotPayload.url.split('?')[0],
                  `/api/v2/ci/test-runs/${expectedTraceId}/media`
                )

                const [idempotencyTraceId, encodedFilename] = screenshotPayload.media.idempotencyKey.split(':')
                assert.strictEqual(idempotencyTraceId, expectedTraceId)
                assert.match(Buffer.from(encodedFilename, 'hex').toString('utf8'), /^test-failed-\d+\.png$/)

                const capturedAt = Number(screenshotPayload.media.capturedAt)
                assert.ok(Number.isInteger(capturedAt) && capturedAt > 0)
                assert.deepStrictEqual(
                  [...screenshotPayload.media.content.subarray(0, 8)],
                  [137, 80, 78, 71, 13, 10, 26, 10]
                )
              },
              { hardTimeout: 60000 }
            )
            .catch((error) => {
              error.message += `\nPlaywright output:\n${getTestOutput()}`
              throw error
            })

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), payloadsPromise])
          assert.strictEqual(exitCode, 1)
          assert.ok(!getTestOutput().includes(SCREENSHOT_CAPTURE_DISABLED_WARNING))
        })
      }

      for (const isScreenshotUploadEnabled of [true, false]) {
        const testName = isScreenshotUploadEnabled
          ? 'warns when screenshot upload is enabled but screenshot capture is off'
          : 'does not warn when screenshot upload is disabled'

        it(testName, async (receiver, run) => {
          const { proc, getTestOutput } = runWithFailureScreenshots(
            receiver,
            run,
            'off',
            isScreenshotUploadEnabled
          )
          const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
            proc,
            ({ url }) => url.startsWith('/api/v2/ci/test-runs/') || url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const mediaPayloads = payloads.filter(({ url }) => url.startsWith('/api/v2/ci/test-runs/'))
              const failedTest = payloads
                .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
                .find(event => event.content.meta[TEST_NAME] === 'uploads only the automatic failure screenshot')

              assert.ok(failedTest, `failed test event should be reported\n${getTestOutput()}`)
              assert.strictEqual(failedTest.content.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], undefined)
              assert.strictEqual(failedTest.content.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
              assert.strictEqual(mediaPayloads.length, 0)
            },
            { hardTimeout: 60000 }
          )

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), payloadsPromise])
          assert.strictEqual(exitCode, 1)
          const warningCount = getTestOutput().split(SCREENSHOT_CAPTURE_DISABLED_WARNING).length - 1
          assert.strictEqual(warningCount, isScreenshotUploadEnabled ? 1 : 0, getTestOutput())
        })
      }

      it('warns when the active transport cannot upload screenshots', async (receiver, run) => {
        receiver.setInfoResponse({ endpoints: [] })
        const { proc, getTestOutput } = runWithFailureScreenshots(
          receiver,
          run,
          'only-on-failure',
          true,
          getCiVisEvpProxyConfig(receiver.port)
        )

        const [exitCode] = await once(proc, 'exit')
        assert.strictEqual(exitCode, 1)
        const warningCount = getTestOutput().split(SCREENSHOT_UPLOAD_UNSUPPORTED_WARNING).length - 1
        assert.strictEqual(warningCount, 1, getTestOutput())
        assert.ok(!getTestOutput().includes(SCREENSHOT_CAPTURE_DISABLED_WARNING))
      })

      it('does not warn when the active transport can upload screenshots', async (receiver, run) => {
        receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        const { proc, getTestOutput } = runWithFailureScreenshots(
          receiver,
          run,
          'only-on-failure',
          true,
          getCiVisEvpProxyConfig(receiver.port)
        )

        const [exitCode] = await once(proc, 'exit')
        assert.strictEqual(exitCode, 1)
        assert.ok(!getTestOutput().includes(SCREENSHOT_UPLOAD_UNSUPPORTED_WARNING), getTestOutput())
        assert.ok(!getTestOutput().includes(SCREENSHOT_CAPTURE_DISABLED_WARNING), getTestOutput())
      })

      it('excludes screenshot upload time from the failed test duration', async (receiver, run) => {
        receiver.setMediaResponseDelay(500)
        const { proc, getTestOutput } = runWithFailureScreenshots(receiver, run)
        const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
          proc,
          ({ url }) => url.startsWith('/api/v2/ci/test-runs/') || url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const mediaPayloads = payloads.filter(({ url }) => url.startsWith('/api/v2/ci/test-runs/'))
            const failedTest = payloads
              .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
              .find(event => event.content.meta[TEST_NAME] === 'uploads only the automatic failure screenshot')

            assert.ok(failedTest, `failed test event should be reported\n${getTestOutput()}`)
            assert.strictEqual(mediaPayloads.length, 1)
            const [screenshotPayload] = mediaPayloads
            const testEndTimeMs = (Number(failedTest.content.start) + Number(failedTest.content.duration)) / 1e6
            assert.ok(
              testEndTimeMs <= screenshotPayload.media.receivedAtMs + 100,
              `test span should finish before the screenshot upload starts\n${getTestOutput()}`
            )
          },
          { hardTimeout: 60000 }
        )

        const [[exitCode]] = await Promise.all([once(proc, 'exit'), payloadsPromise])
        assert.strictEqual(exitCode, 1)
      })

      it('reports upload errors without changing the Playwright result', async (receiver, run) => {
        receiver.setMediaResponseStatusCode(500)
        const { proc, getTestOutput } = runWithFailureScreenshots(receiver, run)
        const payloadsPromise = receiver
          .gatherPayloadsUntilChildExit(
            proc,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const failedTest = payloads
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
                .find(event => event.content.meta[TEST_NAME] === 'uploads only the automatic failure screenshot')

              assert.ok(failedTest, `failed test event should be reported\n${getTestOutput()}`)
              assert.strictEqual(failedTest.content.meta[TEST_STATUS], 'fail')
              assert.strictEqual(failedTest.content.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], 'true')
              assert.strictEqual(failedTest.content.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], undefined)
            },
            { hardTimeout: 60000 }
          )
          .catch((error) => {
            error.message += `\nPlaywright output:\n${getTestOutput()}`
            throw error
          })

        const [[exitCode]] = await Promise.all([once(proc, 'exit'), payloadsPromise])
        assert.strictEqual(exitCode, 1)
      })
    })

    it('works when tests are compiled to a different location', async (receiver, run) => {
      let testOutput = ''
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
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
        }, 25000)
      const proc = run(
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
      proc.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      proc.stderr?.on('data', chunk => { testOutput += chunk.toString() })
      await Promise.all([receiverPromise, once(proc, 'exit')])
    }, { retries: 1 })

    it('works when before all fails and step durations are negative', async (receiver, run) => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
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
        })
      const proc = run(
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
      await Promise.all([receiverPromise, once(proc, 'exit')])
    })

    it('does not crash when maxFailures=1 and there is an error', async (receiver, run) => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvents = events.filter(event => event.type === 'test')
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'failing-test-and-another-test.js.should work with failing tests',
            'failing-test-and-another-test.js.does not crash afterwards',
          ])
        })
      const proc = run(
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
      await Promise.all([receiverPromise, once(proc, 'exit')])
    })

    it(
      'correctly calculates test code owners when working directory is not repository root',
      async (receiver, run) => {
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
        const proc = run(
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
        await Promise.all([eventsPromise, once(proc, 'exit')])
      }
    )

    it('sets _dd.test.is_user_provided_service to true if DD_SERVICE is used', async (receiver, run) => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          tests.forEach(test => {
            assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
          })
        })
      const proc = run(
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
      await Promise.all([receiverPromise, once(proc, 'exit')])
    })

    context('libraries capabilities', () => {
      it('adds capabilities to tests', async (receiver, run) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0, `Expected ${metadataDicts.length} > 0`)
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
              assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session-name')
              assert.strictEqual(metadata.test_levels[TEST_COMMAND], 'playwright test -c playwright.config.js')
            })
          })
        const proc = run(
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
        await Promise.all([eventsPromise, once(proc, 'exit')])
      })
    })

    context('run session status', () => {
      it('session status is not changed if it fails before running any test', async (receiver, run) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          })
        receiver.setSettings({ test_management: { enabled: true } })
        const proc = run(
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
        const [[exitCode]] = await Promise.all([once(proc, 'exit'), receiverPromise])
        assert.strictEqual(exitCode, 1)
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
        it('should report the correct test suite duration when there are skipped tests', async (receiver, run) => {
          const receiverPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSuites = events
                .filter(event => event.type === 'test_suite_end')
                .map(event => event.content)
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
          const proc = run(
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
          await Promise.all([receiverPromise, once(proc, 'exit')])
        })
      })
    })
  })
})
