'use strict'

const assert = require('node:assert/strict')

const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

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
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()

    proxyquire('../src/playwright', {
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
