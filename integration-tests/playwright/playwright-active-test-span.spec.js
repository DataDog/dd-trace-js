'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { exec } = require('child_process')
const { inspect } = require('node:util')

const proxyquire = require('proxyquire').noPreserveCache()
const satisfies = require('semifies')
const sinon = require('sinon')

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
const { createWebAppServerWithRedirect } = require('../ci-visibility/web-app-server-with-redirect')
const {
  TEST_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  TEST_IS_RUM_ACTIVE,
  TEST_BROWSER_VERSION,
} = require('../../packages/dd-trace/src/plugins/util/test')

const { PLAYWRIGHT_VERSION } = process.env

const NUM_RETRIES_EFD = 3

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

    let cwd, webAppPort, webPortWithRedirect, webAppServer, webAppServerWithRedirect

    this.timeout(80000)

    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript'], true)

    before(function (done) {
      // Increase timeout for this hook specifically to account for slow chromium installation in CI
      this.timeout(120000)

      cwd = sandboxCwd()
      installPlaywrightChromium(cwd)

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

    contextNewVersions('active test span', () => {
      it('can grab the test span and add tags', async (receiver, run) => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const test = events.find(event => event.type === 'test').content

            assert.strictEqual(test.meta['test.custom_tag'], 'this is custom')
          })

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })

      it('can grab the test span and add spans', async (receiver, run) => {
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

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })
    })

    contextNewVersions('correlation between tests and RUM sessions', () => {
      const getTestAssertions = (receiver, { isRedirecting }) =>
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
                assert.ok(
                  Object.hasOwn(test.meta, TEST_BROWSER_VERSION),
                  `Available keys: ${inspect(Object.keys(test.meta))}`
                )
              }
            })
          })

      const runRumTest = async (receiver, { isRedirecting }, extraEnvVars) => {
        const testAssertionsPromise = getTestAssertions(receiver, { isRedirecting })
        let proc
        try {
          proc = exec(
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

          const [[exitCode]] = await Promise.all([once(proc, 'exit'), testAssertionsPromise])

          assert.strictEqual(exitCode, isRedirecting ? 1 : 0)
        } finally {
          proc?.kill()
        }
      }

      it('can correlate tests and RUM sessions', async (receiver) => {
        await runRumTest(receiver, { isRedirecting: false })
      })

      for (const failure of ['throw', 'reject']) {
        it(`does not fail when the RUM correlation cookie ${failure}s`, async (receiver) => {
          await runRumTest(receiver, { isRedirecting: false }, {
            RUM_COOKIE_FAILURE: failure,
          })
        })
      }

      it('expires only the RUM correlation cookie during cleanup', async (receiver) => {
        await runRumTest(receiver, { isRedirecting: false }, {
          VERIFY_RUM_COOKIE_CLEANUP: 'true',
        })
      })

      it('sends telemetry for RUM browser tests when telemetry is enabled', async (receiver) => {
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
              assert.ok(tags.includes('is_rum'), `Got: ${inspect(tags)}`)
              assert.ok(tags.includes('test_framework:playwright'), `Got: ${inspect(tags)}`)
            })
          })

        await Promise.all([
          runRumTest(
            receiver,
            { isRedirecting: false },
            {
              ...getCiVisEvpProxyConfig(receiver.port),
              DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            }
          ),
          telemetryPromise,
        ])
      })

      it('do not crash when redirecting and RUM sessions are not active', async (receiver) => {
        await runRumTest(receiver, { isRedirecting: true })
      })
    })

    contextNewVersions('check retries tagging', () => {
      it('does not send attempt to fix tags if test is retried and not attempt to fix', async (receiver, run) => {
        receiver.setKnownTests({ playwright: {} })
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

        const proc = run(
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

        await receiver.gatherPayloadsUntilChildExit(
          proc,
          ({ url }) => url === '/api/v2/citestcycle',
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, NUM_RETRIES_EFD + 1)
            for (const test of tests) {
              assert.ok(!(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED in test.meta))
              assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in test.meta))
            }
          },
          { hardTimeout: 70_000 }
        )
      })
    })

    contextNewVersions('playwright early bail', () => {
      it('reports tests that did not run', async (receiver, run) => {
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

        const proc = run(
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

        await Promise.all([once(proc, 'exit'), receiverPromise])
      })
    })
  })
})

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

describe('playwright instrumentation (unit)', () => {
  let pageHook
  let subscriber
  const testPageGotoCh = {
    get hasSubscribers () {
      return subscriber !== undefined
    },
    publish (context) {
      subscriber?.(context)
    },
  }

  before(() => {
    const realInstrument = require('../../packages/datadog-instrumentations/src/helpers/instrument')
    const addHookSpy = sinon.spy()

    proxyquire('../../packages/datadog-instrumentations/src/playwright', {
      './helpers/instrument': {
        ...realInstrument,
        addHook: addHookSpy,
        channel: name => name === 'ci:playwright:test:page-goto'
          ? testPageGotoCh
          : realInstrument.channel(name),
      },
    })

    const call = addHookSpy.getCalls().find(({ args }) => {
      const target = args[0]
      return target.name === 'playwright-core' && target.file === 'lib/client/page.js'
    })
    pageHook = call.args[1]
  })

  afterEach(() => {
    subscriber = undefined
  })

  function subscribe (listener) {
    subscriber = listener
  }

  function createPage ({
    addCookies = async () => {},
    browser = () => ({ version: () => '123.0.0' }),
    evaluate = async () => ({
      isRumInstrumented: true,
      isRumActive: true,
      rumSamplingRate: 100,
    }),
    goto = async () => 'response',
    url = () => 'http://localhost/test',
  } = {}) {
    class Page {
      context () {
        return { addCookies, browser }
      }

      evaluate () {
        return evaluate()
      }

      goto () {
        return goto()
      }

      url () {
        return url()
      }
    }

    pageHook({ Page })
    return new Page()
  }

  it('does not inspect the page without a subscriber', async () => {
    const evaluate = sinon.spy()
    const page = createPage({ evaluate })

    assert.strictEqual(await page.goto(), 'response')
    assert.strictEqual(evaluate.callCount, 0)
  })

  it('does not set a cookie without an active test span', async () => {
    const addCookies = sinon.spy()
    subscribe(() => {})

    const page = createPage({ addCookies })

    assert.strictEqual(await page.goto(), 'response')
    assert.strictEqual(addCookies.callCount, 0)
  })

  it('contains a non-Error RUM detection rejection', async () => {
    subscribe(() => {})
    const page = createPage({
      // Intentionally reject with a non-Error to pin defensive logging.
      // eslint-disable-next-line prefer-promise-reject-errors
      evaluate: () => Promise.reject('detection rejected'),
    })

    assert.strictEqual(await page.goto(), 'response')
  })

  it('does not set a cookie when RUM is inactive', async () => {
    const addCookies = sinon.spy()
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })
    const page = createPage({
      addCookies,
      evaluate: async () => ({
        isRumInstrumented: true,
        isRumActive: false,
        rumSamplingRate: 10,
      }),
    })

    assert.strictEqual(await page.goto(), 'response')
    assert.strictEqual(addCookies.callCount, 0)
  })

  it('sets the correlation cookie without a browser instance', async () => {
    const addCookies = sinon.spy()
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })

    const page = createPage({
      addCookies,
      browser: () => null,
    })

    assert.strictEqual(await page.goto(), 'response')
    assert.deepStrictEqual(addCookies.firstCall.args[0], [{
      name: RUM_COOKIE_NAME,
      value: '1234',
      domain: 'localhost',
      path: '/',
    }])
  })

  it('sets the correlation cookie when browser metadata collection throws', async () => {
    const addCookies = sinon.spy()
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })

    const page = createPage({
      addCookies,
      browser: () => {
        throw new Error('browser metadata failed')
      },
    })

    assert.strictEqual(await page.goto(), 'response')
    assert.strictEqual(addCookies.callCount, 1)
  })

  it('contains channel publication failures', async () => {
    const addCookies = sinon.spy()
    subscribe(() => {
      throw new Error('subscriber failed')
    })
    const page = createPage({ addCookies })

    assert.strictEqual(await page.goto(), 'response')
    assert.strictEqual(addCookies.callCount, 0)
  })

  it('contains synchronous and asynchronous cookie failures', async () => {
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })

    const synchronousPage = createPage({
      addCookies: () => {
        throw new Error('cookie failed')
      },
    })
    const asynchronousPage = createPage({
      // Intentionally reject with a non-Error to pin defensive logging.
      // eslint-disable-next-line prefer-promise-reject-errors
      addCookies: () => Promise.reject('cookie rejected'),
    })

    assert.strictEqual(await synchronousPage.goto(), 'response')
    assert.strictEqual(await asynchronousPage.goto(), 'response')
  })

  it('contains an invalid page URL', async () => {
    const addCookies = sinon.spy()
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })

    const page = createPage({
      addCookies,
      url: () => '',
    })

    assert.strictEqual(await page.goto(), 'response')
    assert.strictEqual(addCookies.callCount, 0)
  })

  it('does not set a cookie when the subscriber is removed during RUM detection', async () => {
    let resolveDetection
    const addCookies = sinon.spy()
    const listener = ctx => {
      ctx.testExecutionId = '1234'
    }
    subscribe(listener)

    const page = createPage({
      addCookies,
      evaluate: () => new Promise(resolve => {
        resolveDetection = resolve
      }),
    })
    const gotoPromise = page.goto()

    await new Promise(setImmediate)
    subscriber = undefined
    resolveDetection({
      isRumInstrumented: true,
      isRumActive: true,
      rumSamplingRate: 100,
    })

    assert.strictEqual(await gotoPromise, 'response')
    assert.strictEqual(addCookies.callCount, 0)
  })

  it('preserves the original navigation failure', async () => {
    const failure = new Error('navigation failed')
    const evaluate = sinon.spy()
    subscribe(() => {})

    const page = createPage({
      evaluate,
      goto: () => Promise.reject(failure),
    })

    await assert.rejects(page.goto(), error => error === failure)
    assert.strictEqual(evaluate.callCount, 0)
  })
})
