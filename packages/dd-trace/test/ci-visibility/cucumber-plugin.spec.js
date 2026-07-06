'use strict'

const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const testUtil = require('../../src/plugins/util/test')

describe('CucumberPlugin', () => {
  let CucumberPlugin

  beforeEach(() => {
    class FakeCiPlugin {
      constructor () {
        this.subscriptions = new Map()
        this.bindings = new Map()
      }

      addSub (channelName, handler) {
        this.subscriptions.set(channelName, handler)
      }

      addBind (channelName, transform) {
        this.bindings.set(channelName, transform)
      }
    }

    CucumberPlugin = proxyquire('../../../datadog-plugin-cucumber/src', {
      '../../dd-trace/src/plugins/ci_plugin': FakeCiPlugin,
      '../../dd-trace/src/plugins/util/test': {
        ...testUtil,
        finishAllTraceSpans: sinon.stub(),
      },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('prepares a breakpoint-hit wait before each retried attempt while a probe is active', () => {
    const plugin = new CucumberPlugin()
    const retryHandler = plugin.subscriptions.get('ci:cucumber:test:retry')
    const span = {
      setTag: sinon.stub(),
      finish: sinon.stub(),
    }

    plugin.di = {}
    plugin.libraryConfig = { isDiEnabled: true }
    plugin.runningTestProbe = { file: 'test.js', line: 1 }
    plugin.prepareDiBreakpointHitWait = sinon.stub()

    retryHandler({
      span,
      isFirstAttempt: false,
      error: new Error('failed attempt'),
      isAtrRetry: true,
      promises: {},
      canWaitForDi: true,
    })

    sinon.assert.calledOnce(plugin.prepareDiBreakpointHitWait)
  })
})
