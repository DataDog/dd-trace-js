'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('Playwright known-tests failures', () => {
  let hooks, log, subscriptions

  beforeEach(() => {
    hooks = []
    log = { error: sinon.spy() }
    subscriptions = []
    proxyquire('../../src/playwright', {
      './helpers/instrument': {
        '@noCallThru': true,
        addHook: (options, hook) => hooks.push({ options, hook }),
        channel: name => dc.channel(name),
        tracingChannel: () => ({ subscribe () {} }),
      },
      '../../dd-trace/src/log': log,
    })
  })

  afterEach(() => {
    for (const [channel, handler] of subscriptions) channel.unsubscribe(handler)
  })

  for (const { name, response, enabled, faulty } of [
    { name: 'a failed request', response: { err: new Error('Request failed') }, enabled: false, faulty: false },
    { name: 'missing tests', response: {}, enabled: false, faulty: true },
    { name: 'null tests', response: { knownTests: null }, enabled: false, faulty: true },
    { name: 'a missing framework', response: { knownTests: {} }, enabled: false, faulty: true },
    { name: 'valid tests', response: { knownTests: { playwright: {} } }, enabled: true, faulty: false },
  ]) {
    it(`handles ${name} without reporting an internal exception`, async () => {
      const finish = sinon.spy()
      const responses = {
        'ci:playwright:library-configuration': {
          libraryConfig: { isKnownTestsEnabled: true, isEarlyFlakeDetectionEnabled: true },
        },
        'ci:playwright:known-tests': response,
      }
      for (const name of [...Object.keys(responses), 'ci:playwright:session:finish']) {
        const channel = dc.channel(name)
        const handler = context => {
          if (name === 'ci:playwright:session:finish') finish(context)
          context.onDone(responses[name])
        }
        channel.subscribe(handler)
        subscriptions.push([channel, handler])
      }

      class Runner {
        _config = { config: { rootDir: process.cwd() }, projects: [] }

        async runAllTests () {
          return 'passed'
        }
      }
      const { hook } = hooks.find(({ options }) =>
        options.name === 'playwright' && options.file === 'lib/runner/runner.js'
      )
      hook({ Runner }, '1.38.0')

      assert.strictEqual(await new Runner().runAllTests(), 'passed')
      sinon.assert.notCalled(log.error)
      sinon.assert.calledOnceWithMatch(finish, {
        isEarlyFlakeDetectionEnabled: enabled,
        isEarlyFlakeDetectionFaulty: faulty,
      })
    })
  }
})
