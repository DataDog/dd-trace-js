'use strict'

const t = require('tap')
require('../../../../../dd-trace/test/setup/core')

const TestWorkerCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/test-worker')
const {
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE
} = require('../../../../src/plugins/util/test')

t.test('CI Visibility Test Worker Exporter', t => {
  let send, originalSend

  t.beforeEach(() => {
    send = sinon.spy()
    originalSend = process.send
    process.send = send
  })

  t.afterEach(() => {
    process.send = originalSend
  })

  context('when the process is a jest worker', () => {
    t.beforeEach(() => {
      process.env.JEST_WORKER_ID = '1'
    })
    t.afterEach(() => {
      delete process.env.JEST_WORKER_ID
    })

    t.test('can export traces', t => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.export(traceSecond)
      jestWorkerExporter.flush()
      expect(send).to.have.been.calledWith([JEST_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
      t.end()
    })

    t.test('can export coverages', t => {
      const coverage = { sessionId: '1', suiteId: '1', files: ['test.js'] }
      const coverageSecond = { sessionId: '2', suiteId: '2', files: ['test2.js'] }
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.exportCoverage(coverage)
      jestWorkerExporter.exportCoverage(coverageSecond)
      jestWorkerExporter.flush()
      expect(send).to.have.been.calledWith(
        [JEST_WORKER_COVERAGE_PAYLOAD_CODE, JSON.stringify([coverage, coverageSecond])]
      )
      t.end()
    })

    t.test('does not break if process.send is undefined', t => {
      delete process.send
      const trace = [{ type: 'test' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.flush()
      expect(send).not.to.have.been.called
      t.end()
    })
  })

  context('when the process is a cucumber worker', () => {
    t.beforeEach(() => {
      process.env.CUCUMBER_WORKER_ID = '1'
    })
    t.afterEach(() => {
      delete process.env.CUCUMBER_WORKER_ID
    })

    t.test('can export traces', t => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.export(traceSecond)
      cucumberWorkerExporter.flush()
      expect(send).to.have.been.calledWith([CUCUMBER_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
      t.end()
    })

    t.test('does not break if process.send is undefined', t => {
      delete process.send
      const trace = [{ type: 'test' }]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.flush()
      expect(send).not.to.have.been.called
      t.end()
    })
  })

  context('when the process is a mocha worker', () => {
    t.beforeEach(() => {
      process.env.MOCHA_WORKER_ID = '1'
    })
    t.afterEach(() => {
      delete process.env.MOCHA_WORKER_ID
    })

    t.test('can export traces', t => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.export(trace)
      mochaWorkerExporter.export(traceSecond)
      mochaWorkerExporter.flush()
      expect(send).to.have.been.calledWith([MOCHA_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
      t.end()
    })

    t.test('does not break if process.send is undefined', t => {
      delete process.send
      const trace = [{ type: 'test' }]
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.export(trace)
      mochaWorkerExporter.flush()
      expect(send).not.to.have.been.called
      t.end()
    })
  })
  t.end()
})
