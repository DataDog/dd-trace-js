'use strict'

require('../../../../../dd-trace/test/setup/tap')

const JestWorkerCiVisibilityExporter = require('../../../../src/ci-visibility/exporters/jest-worker')
const {
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE
} = require('../../../../src/plugins/util/test')

describe('CI Visibility Jest Worker Exporter', () => {
  let send, originalSend
  beforeEach(() => {
    send = sinon.spy()
    originalSend = process.send
    process.send = send
  })
  afterEach(() => {
    process.send = originalSend
  })
  it('can export traces', () => {
    const trace = [{ type: 'test' }]
    const traceSecond = [{ type: 'test', name: 'other' }]
    const jestWorkerExporter = new JestWorkerCiVisibilityExporter()
    jestWorkerExporter.export(trace)
    jestWorkerExporter.export(traceSecond)
    jestWorkerExporter.flush()
    expect(send).to.have.been.calledWith([JEST_WORKER_TRACE_PAYLOAD_CODE, JSON.stringify([trace, traceSecond])])
  })
  it('can export coverages', () => {
    const coverage = { traceId: '1', spanId: '1', files: ['test.js'] }
    const coverageSecond = { traceId: '2', spanId: '2', files: ['test2.js'] }
    const jestWorkerExporter = new JestWorkerCiVisibilityExporter()
    jestWorkerExporter.exportCoverage(coverage)
    jestWorkerExporter.exportCoverage(coverageSecond)
    jestWorkerExporter.flush()
    expect(send).to.have.been.calledWith(
      [JEST_WORKER_COVERAGE_PAYLOAD_CODE, JSON.stringify([coverage, coverageSecond])]
    )
  })
  it('does not break if process.send is undefined', () => {
    delete process.send
    const trace = [{ type: 'test' }]
    const jestWorkerExporter = new JestWorkerCiVisibilityExporter()
    jestWorkerExporter.export(trace)
    jestWorkerExporter.flush()
    expect(send).not.to.have.been.called
  })
})
