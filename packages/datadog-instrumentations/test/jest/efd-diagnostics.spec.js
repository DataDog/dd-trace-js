'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const dc = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('Jest Early Flake Detection diagnostics', () => {
  const subscriptions = []

  afterEach(() => {
    for (const [channel, handler] of subscriptions) channel.unsubscribe(handler)
    subscriptions.length = 0
  })

  for (const { knownTests, reason } of [
    { knownTests: {}, reason: 'the known tests response does not contain Jest tests' },
    { knownTests: { jest: {} }, reason: 'the number of new suites is too high' },
  ]) {
    it(`warns when ${reason} and preserves the suite list`, async () => {
      const hooks = []
      const log = { error: sinon.spy(), warn: sinon.spy() }
      proxyquire('../../src/jest', {
        './helpers/instrument': {
          '@noCallThru': true,
          addHook: (options, hook) => hooks.push({ options, hook }),
          channel: name => dc.channel(name),
          getHooks: () => new Map(),
          tracingChannel: () => ({ subscribe () {}, end: { subscribe () {} } }),
        },
        '../../dd-trace/src/log': log,
      })

      for (const [name, response] of Object.entries({
        'ci:jest:library-configuration': {
          libraryConfig: {
            isKnownTestsEnabled: true,
            isEarlyFlakeDetectionEnabled: true,
            earlyFlakeDetectionFaultyThreshold: 1,
          },
        },
        'ci:jest:known-tests': { knownTests },
      })) {
        const channel = dc.channel(name)
        const handler = ({ onDone }) => onDone(response)
        channel.subscribe(handler)
        subscriptions.push([channel, handler])
      }

      const rootDir = process.cwd()
      const config = { rootDir, testEnvironmentOptions: {} }
      const suites = {
        tests: ['one.spec.js', 'two.spec.js'].map(file => ({ path: path.join(rootDir, file), context: { config } })),
      }
      class SearchSource {
        async getTestPaths () {
          return suites
        }
      }
      hooks.find(({ options }) => options.file === 'build/SearchSource.js').hook({ default: SearchSource }, '29.7.0')
      const result = { results: { success: true, numPassedTests: 1, numFailedTests: 0, testResults: [] } }
      const cli = {
        async runCLI () {
          assert.strictEqual(await new SearchSource().getTestPaths({ rootDir }), suites)
          return result
        },
      }
      hooks.find(({ options }) => options.file === 'build/cli/index.js').hook(cli, '29.7.0')

      assert.strictEqual(await cli.runCLI(), result)
      sinon.assert.notCalled(log.error)
      sinon.assert.calledOnceWithExactly(log.warn, `Early flake detection is disabled because ${reason}.`)
      assert.strictEqual(config.testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled, false)
      assert.strictEqual(config.testEnvironmentOptions._ddIsKnownTestsEnabled, false)
    })
  }
})
