'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const nock = require('nock')

require('../../../../../dd-trace/test/setup/core')
const log = require('../../../../src/log')

const DynamicInstrumentationLogsWriterWithApiKey = proxyquire(
  '../../../../src/ci-visibility/exporters/agentless/di-logs-writer',
  { '../../../config': () => ({ DD_API_KEY: '1' }) }
)
const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')

describe('Test Visibility DI Writer', () => {
  beforeEach(() => {
    nock.cleanAll()
  })

  afterEach(() => {
    sinon.restore()
  })

  context('agentless', () => {
    it('uses the dedicated Test Optimization agent', (done) => {
      const agent = {}
      const request = sinon.stub().yieldsAsync(null, 'OK', 202)
      const TestOptimizationLogsWriter = proxyquire(
        '../../../../src/ci-visibility/exporters/agentless/di-logs-writer',
        {
          '../agents': { getAgent: () => agent },
          '../request': request,
          '../../../config': () => ({ DD_API_KEY: '1' }),
        }
      )
      const logsWriter = new TestOptimizationLogsWriter({ url: 'http://www.example.com' })

      logsWriter.append({ message: 'test' })
      logsWriter.flush(() => {
        sinon.assert.calledWithMatch(request, sinon.match.any, { agent })
        done()
      })
    })

    it('can send logs to the logs intake', (done) => {
      const scope = nock('http://www.example.com')
        .post('/api/v2/logs', body => {
          assert.deepStrictEqual(body, [{ message: 'test' }, { message: 'test2' }])
          return true
        })
        .reply(202)

      const logsWriter = new DynamicInstrumentationLogsWriterWithApiKey({ url: 'http://www.example.com' })

      logsWriter.append({ message: 'test' })
      logsWriter.append({ message: 'test2' })

      logsWriter.flush(() => {
        scope.done()
        done()
      })
    })

    it('reports enriched telemetry when a payload is dropped', (done) => {
      const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      const incrementCountMetric = sinon.stub()
      const request = sinon.stub().yieldsAsync(error, null, undefined)
      const TestOptimizationLogsWriter = proxyquire(
        '../../../../src/ci-visibility/exporters/agentless/di-logs-writer',
        {
          '../request': request,
          '../../../ci-visibility/telemetry': { incrementCountMetric },
          '../../../config': () => ({ DD_API_KEY: '1' }),
        }
      )
      const logsWriter = new TestOptimizationLogsWriter({ url: 'http://www.example.com' })

      logsWriter.append({ message: 'test' })
      logsWriter.flush(() => {
        sinon.assert.calledWithExactly(
          incrementCountMetric,
          'endpoint_payload.requests_errors',
          { endpoint: 'di_logs', statusCode: undefined, errorType: 'ECONNRESET' }
        )
        sinon.assert.calledWithExactly(
          incrementCountMetric,
          'endpoint_payload.dropped',
          { endpoint: 'di_logs', statusCode: undefined, errorType: 'ECONNRESET' }
        )
        done()
      })
    })

    it('logs an error if the request fails', (done) => {
      const logErrorSpy = sinon.spy(log, 'error')

      const scope = nock('http://www.example.com')
        .post('/api/v2/logs')
        .reply(400)

      const logsWriter = new DynamicInstrumentationLogsWriterWithApiKey({ url: 'http://www.example.com' })

      logsWriter.append({ message: 'test5' })
      logsWriter.append({ message: 'test6' })

      logsWriter.flush(() => {
        assert.strictEqual(logErrorSpy.called, true)
        scope.done()
        done()
      })
    })
  })

  context('agent based', () => {
    it('can send logs to the debugger endpoint in the agent', (done) => {
      const scope = nock('http://www.example.com')
        .post('/debugger/v1/input', body => {
          assert.deepStrictEqual(body, [{ message: 'test3' }, { message: 'test4' }])
          return true
        })
        .reply(202)

      const logsWriter = new DynamicInstrumentationLogsWriter({ url: 'http://www.example.com', isAgentProxy: true })

      logsWriter.append({ message: 'test3' })
      logsWriter.append({ message: 'test4' })

      logsWriter.flush(() => {
        scope.done()
        done()
      })
    })

    it('logs an error if the request fails', (done) => {
      const logErrorSpy = sinon.spy(log, 'error')

      const scope = nock('http://www.example.com')
        .post('/debugger/v1/input')
        .reply(400)

      const logsWriter = new DynamicInstrumentationLogsWriter({ url: 'http://www.example.com', isAgentProxy: true })

      logsWriter.append({ message: 'test5' })
      logsWriter.append({ message: 'test6' })

      logsWriter.flush(() => {
        assert.strictEqual(logErrorSpy.called, true)
        scope.done()
        done()
      })
    })
  })
})
