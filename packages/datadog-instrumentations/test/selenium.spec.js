'use strict'

const assert = require('node:assert/strict')

const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

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
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()

    proxyquire('../src/selenium', {
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
