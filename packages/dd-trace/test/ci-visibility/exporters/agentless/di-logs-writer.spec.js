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
  { '../../../config': () => ({ apiKey: '1' }) }
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

    it('logs an error if the request fails', (done) => {
      const logErrorSpy = sinon.spy(log, 'error')

      const scope = nock('http://www.example.com')
        .post('/api/v2/logs')
        .reply(500)

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
        .reply(500)

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
