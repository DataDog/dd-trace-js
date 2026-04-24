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
const { createWebAppServerWithRedirect } = require('../ci-visibility/web-app-server-with-redirect')
const {
  TEST_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_VERSION,
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
    let cwd, receiver, childProcess, webAppPort, webPortWithRedirect, webAppServer, webAppServerWithRedirect

    this.retries(2)
    this.timeout(80000)

    // TODO: Update tests files accordingly and test with different TS versions
    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript@5'], true)

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
