'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const sinon = require('sinon')

require('../../../../../dd-trace/test/setup/core')
const TestWorkerCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/test-worker')

const {
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
} = require('../../../../src/plugins/util/test')

describe('CI Visibility Test Worker Exporter', () => {
  let send, originalSend

  beforeEach(() => {
    send = sinon.spy()
    originalSend = process.send
    process.send = send
  })

  afterEach(() => {
    process.send = originalSend
  })

  context('when the process is a jest worker', () => {
    beforeEach(() => {
      process.env.JEST_WORKER_ID = '1'
    })
    afterEach(() => {
      delete process.env.JEST_WORKER_ID
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.export(traceSecond)
      jestWorkerExporter.flush()
      sinon.assert.calledWith(send, [JEST_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('can export coverages', () => {
      const coverage = { sessionId: '1', suiteId: '1', files: ['test.js'] }
      const coverageSecond = { sessionId: '2', suiteId: '2', files: ['test2.js'] }
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.exportCoverage(coverage)
      jestWorkerExporter.exportCoverage(coverageSecond)
      jestWorkerExporter.flush()
      sinon.assert.calledWith(send,
        [JEST_WORKER_COVERAGE_PAYLOAD_CODE, JSON.stringify([coverage, coverageSecond])]
      )
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const jestWorkerExporter = new TestWorkerCiVisibilityExporter()
      jestWorkerExporter.export(trace)
      jestWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })

  context('when the process is a cucumber worker', () => {
    beforeEach(() => {
      process.env.CUCUMBER_WORKER_ID = '1'
    })
    afterEach(() => {
      delete process.env.CUCUMBER_WORKER_ID
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.export(traceSecond)
      cucumberWorkerExporter.flush()
      sinon.assert.calledWith(send, [CUCUMBER_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const cucumberWorkerExporter = new TestWorkerCiVisibilityExporter()
      cucumberWorkerExporter.export(trace)
      cucumberWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })

  context('when the process is a mocha worker', () => {
    beforeEach(() => {
      process.env.MOCHA_WORKER_ID = '1'
    })
    afterEach(() => {
      delete process.env.MOCHA_WORKER_ID
    })

    it('can export traces', () => {
      const trace = [{ type: 'test' }]
      const traceSecond = [{ type: 'test', name: 'other' }]
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.export(trace)
      mochaWorkerExporter.export(traceSecond)
      mochaWorkerExporter.flush()
      sinon.assert.calledWith(send, [MOCHA_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
    })

    it('does not break if process.send is undefined', () => {
      delete process.send
      const trace = [{ type: 'test' }]
      const mochaWorkerExporter = new TestWorkerCiVisibilityExporter()
      mochaWorkerExporter.export(trace)
      mochaWorkerExporter.flush()
      sinon.assert.notCalled(send)
    })
  })
})
