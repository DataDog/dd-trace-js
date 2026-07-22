'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('child_process')
const { inspect } = require('node:util')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION,
  TEST_BROWSER_DRIVER_VERSION,
  TEST_IS_RUM_ACTIVE,
  TEST_TYPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const webAppServer = require('../ci-visibility/web-app-server')

const versionRange = ['4.11.0', 'latest']
const isLatestCucumberSupported = NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26

versionRange.forEach(version => {
  describe(`selenium ${version}`, () => {
    let receiver
    let childProcess
    let cwd
    let webAppPort

    useSandbox([
      'mocha',
      'jest',
      ...(isLatestCucumberSupported ? ['@cucumber/cucumber'] : []),
      `selenium-webdriver@${version}`,
    ])

    before(function (done) {
      cwd = sandboxCwd()

      webAppServer.listen(0, () => {
        const address = webAppServer.address()
        if (!address || typeof address === 'string') {
          return done(new Error('Failed to determine web app server port'))
        }
        webAppPort = address.port
        done()
      })
    })

    after(async function () {
      await new Promise(resolve => webAppServer.close(resolve))
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    const testFrameworks = [
      {
        name: 'mocha',
        command: 'mocha ./ci-visibility/test/selenium-test.js --timeout 10000',
      },
      {
        name: 'jest',
        command: 'node ./node_modules/jest/bin/jest --config config-jest.js',
      },
      {
        name: 'cucumber',
        command: './node_modules/.bin/cucumber-js ci-visibility/features-selenium/*.feature',
      },
    ]
    testFrameworks.forEach(({ name, command }) => {
      if (!isLatestCucumberSupported && name === 'cucumber') return

      context(`with ${name}`, () => {
        it('identifies tests using selenium as browser tests', async () => {
          const assertionPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const seleniumTest = events.find(event => event.type === 'test').content

              assertObjectContains(seleniumTest, {
                meta: {
                  [TEST_BROWSER_DRIVER]: 'selenium',
                  [TEST_BROWSER_NAME]: 'chrome',
                  [TEST_TYPE]: 'browser',
                  [TEST_IS_RUM_ACTIVE]: 'true',
                },
              })

              assert.ok(
                Object.hasOwn(seleniumTest.meta, TEST_BROWSER_VERSION),
                `Available keys: ${inspect(Object.keys(seleniumTest.meta))}`
              )
              assert.ok(
                Object.hasOwn(seleniumTest.meta, TEST_BROWSER_DRIVER_VERSION),
                `Available keys: ${inspect(Object.keys(seleniumTest.meta))}`
              )
            })

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
                assert.ok(tags.includes('browser_driver:selenium'), `Got: ${inspect(tags)}`)
              })
            })

          childProcess = exec(
            command,
            {
              cwd,
              env: {
                ...getCiVisEvpProxyConfig(receiver.port),
                WEB_APP_URL: `http://localhost:${webAppPort}`,
                TESTS_TO_RUN: '**/ci-visibility/test/selenium-test*',
                DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            assertionPromise,
            telemetryPromise,
          ])
        })
      })
    })

    for (const failure of ['throw', 'reject']) {
      it(`does not fail tests when RUM correlation cookie operations ${failure}`, async () => {
        let testOutput = ''
        childProcess = exec(
          './node_modules/.bin/mocha ./ci-visibility/test/selenium-test.js --timeout 60000',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              WEB_APP_URL: `http://localhost:${webAppPort}`,
              TESTS_TO_RUN: '**/ci-visibility/test/selenium-test*',
              RUM_COOKIE_FAILURE: failure,
            },
          }
        )
        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        const [exitCode] = await once(childProcess, 'exit')

        assert.strictEqual(exitCode, 0, testOutput)
      })
    }

    it('does not crash when used outside a known test framework', (done) => {
      let testOutput = ''
      childProcess = exec(
        'node ./ci-visibility/test/selenium-no-framework.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            WEB_APP_URL: `http://localhost:${webAppPort}`,
            TESTS_TO_RUN: '**/ci-visibility/test/selenium-test*',
          },
        }
      )

      childProcess.on('exit', (code) => {
        assert.strictEqual(code, 0, `Process exited with code ${code}.\n${testOutput}`)
        assert.doesNotMatch(testOutput, /InvalidArgumentError/)
        done()
      })

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
    })
  })
})

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

describe('selenium instrumentation (unit)', () => {
  let seleniumHook
  let subscriber
  const driverGetCh = {
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

    proxyquire('../../packages/datadog-instrumentations/src/selenium', {
      './helpers/instrument': {
        ...realInstrument,
        addHook: addHookSpy,
        channel: () => driverGetCh,
      },
      '../../dd-trace/src/config/helper': {
        getValueFromEnvSources: () => 0,
      },
    })

    seleniumHook = addHookSpy.firstCall.args[1]
  })

  afterEach(() => {
    subscriber = undefined
  })

  function subscribe (listener) {
    subscriber = listener
  }

  function createDriver ({
    addCookie = async () => {},
    capabilities = async () => ({
      getBrowserName: () => 'chrome',
      getBrowserVersion: () => '123.0.0',
    }),
    deleteCookie = async () => {},
    detectRum = async () => true,
    get = async () => 'navigation result',
    quit = async () => 'quit result',
    stopRum = async () => true,
  } = {}) {
    class WebDriver {
      executeScript (script) {
        return script.includes('stopSession') ? stopRum() : detectRum()
      }

      get () {
        return get()
      }

      getCapabilities () {
        return capabilities()
      }

      manage () {
        return { addCookie, deleteCookie }
      }

      quit () {
        return quit()
      }
    }

    seleniumHook({ WebDriver }, '4.11.0')
    return new WebDriver()
  }

  it('does not inspect the driver without a subscriber', async () => {
    const detectRum = sinon.spy()
    const driver = createDriver({ detectRum })

    assert.strictEqual(await driver.get('http://localhost'), 'navigation result')
    assert.strictEqual(detectRum.callCount, 0)
  })

  it('publishes browser metadata when RUM detection rejects', async () => {
    let context
    subscribe(ctx => {
      context = ctx
    })
    const driver = createDriver({
      // Intentionally reject with a non-Error to pin defensive logging.
      // eslint-disable-next-line prefer-promise-reject-errors
      detectRum: () => Promise.reject('detection rejected'),
    })

    assert.strictEqual(await driver.get('http://localhost'), 'navigation result')
    assert.deepStrictEqual(context, {
      seleniumVersion: '4.11.0',
      browserName: 'chrome',
      browserVersion: '123.0.0',
      isRumActive: undefined,
      testExecutionId: undefined,
    })
  })

  it('sets the cookie when capability collection rejects', async () => {
    const addCookie = sinon.spy()
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })
    const driver = createDriver({
      addCookie,
      capabilities: () => Promise.reject(new Error('capabilities failed')),
    })

    assert.strictEqual(await driver.get('http://localhost'), 'navigation result')
    assert.deepStrictEqual(addCookie.firstCall.args[0], {
      name: RUM_COOKIE_NAME,
      value: '1234',
    })
  })

  it('contains channel publication failures', async () => {
    const addCookie = sinon.spy()
    subscribe(() => {
      throw new Error('subscriber failed')
    })
    const driver = createDriver({ addCookie })

    assert.strictEqual(await driver.get('http://localhost'), 'navigation result')
    assert.strictEqual(addCookie.callCount, 0)
  })

  it('contains synchronous and asynchronous cookie failures', async () => {
    subscribe(ctx => {
      ctx.testExecutionId = '1234'
    })

    const synchronousDriver = createDriver({
      addCookie: () => {
        throw new Error('cookie failed')
      },
    })
    const asynchronousDriver = createDriver({
      // Intentionally reject with a non-Error to pin defensive logging.
      // eslint-disable-next-line prefer-promise-reject-errors
      addCookie: () => Promise.reject('cookie rejected'),
    })

    assert.strictEqual(await synchronousDriver.get('http://localhost'), 'navigation result')
    assert.strictEqual(await asynchronousDriver.get('http://localhost'), 'navigation result')
  })

  it('reaches the real quit when RUM session cleanup rejects', async () => {
    const quit = sinon.spy(() => Promise.resolve('quit result'))
    subscribe(() => {})
    const driver = createDriver({
      // Intentionally reject with a non-Error to pin defensive logging.
      // eslint-disable-next-line prefer-promise-reject-errors
      deleteCookie: () => Promise.reject('delete rejected'),
      quit,
    })

    assert.strictEqual(await driver.quit(), 'quit result')
    assert.strictEqual(quit.callCount, 1)
  })

  it('reaches the real quit when stopping the RUM session throws', async () => {
    const deleteCookie = sinon.spy()
    const quit = sinon.spy(() => Promise.resolve('quit result'))
    subscribe(() => {})
    const driver = createDriver({
      deleteCookie,
      quit,
      stopRum: () => {
        throw new Error('stop failed')
      },
    })

    assert.strictEqual(await driver.quit(), 'quit result')
    assert.strictEqual(deleteCookie.callCount, 0)
    assert.strictEqual(quit.callCount, 1)
  })

  it('preserves the original navigation and quit failures', async () => {
    const navigationFailure = new Error('navigation failed')
    const quitFailure = new Error('quit failed')
    subscribe(() => {})
    const driver = createDriver({
      get: () => Promise.reject(navigationFailure),
      quit: () => Promise.reject(quitFailure),
    })

    await assert.rejects(driver.get('http://localhost'), error => error === navigationFailure)
    await assert.rejects(driver.quit(), error => error === quitFailure)
  })
})
