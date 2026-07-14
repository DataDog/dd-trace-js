'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const handlers = new Map()

class CiPlugin {
  constructor (tracer, tracerConfig) {
    this.tracer = tracer
    this._tracerConfig = tracerConfig
    this.libraryConfig = {}
  }

  addSub (name, handler) {
    handlers.set(name, handler)
  }

  addBind () {}

  _exportPendingWorkerTraces () {}

  get telemetry () {
    return {
      ciVisEvent: () => {},
      count: () => {},
    }
  }
}

const CucumberPlugin = proxyquire('../src', {
  '../../dd-trace/src/plugins/ci_plugin': CiPlugin,
  '../../dd-trace/src/plugins/util/test': {
    addIntelligentTestRunnerSpanTags: () => {},
    finishAllTraceSpans: () => {},
  },
})

describe('CucumberPlugin', () => {
  it('passes the session completion callback to the exporter flush', () => {
    const exporter = { flush: sinon.spy() }
    const tracer = { _exporter: exporter }
    const tracerConfig = {
      testOptimization: {
        DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER: false,
      },
    }
    const plugin = new CucumberPlugin(tracer, tracerConfig)
    const span = {
      finish: sinon.spy(),
      setTag: sinon.spy(),
    }
    const onDone = sinon.spy()

    plugin.testSessionSpan = span
    plugin.testModuleSpan = span

    handlers.get('ci:cucumber:session:finish')({
      status: 'pass',
      isSuitesSkipped: false,
      numSkippedSuites: 0,
      isEarlyFlakeDetectionEnabled: false,
      isEarlyFlakeDetectionFaulty: false,
      isTestManagementTestsEnabled: false,
      isParallel: false,
      onDone,
    })

    assert.strictEqual(exporter.flush.calledOnceWithExactly(onDone), true)
  })
})
