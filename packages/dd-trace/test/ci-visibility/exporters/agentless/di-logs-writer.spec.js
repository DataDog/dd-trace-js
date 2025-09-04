'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, context } = require('tap').mocha
const sinon = require('sinon')
const nock = require('nock')

require('../../../../../dd-trace/test/setup/core')

const DynamicInstrumentationLogsWriter = require('../../../../src/ci-visibility/exporters/agentless/di-logs-writer')
const log = require('../../../../src/log')

describe('Test Visibility DI Writer', () => {
  beforeEach(() => {
    nock.cleanAll()
    process.env.DD_API_KEY = '1'
  })

  afterEach(() => {
    delete process.env.DD_API_KEY
    sinon.restore()
  })

  context('agentless', () => {
    it('can send logs to the logs intake', (done) => {
      const scope = nock('http://www.example.com')
        .post('/api/v2/logs', body => {
          expect(body).to.deep.equal([{ message: 'test' }, { message: 'test2' }])
          return true
        })
        .reply(202)

      const logsWriter = new DynamicInstrumentationLogsWriter({ url: 'http://www.example.com' })

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

      const logsWriter = new DynamicInstrumentationLogsWriter({ url: 'http://www.example.com' })

      logsWriter.append({ message: 'test5' })
      logsWriter.append({ message: 'test6' })

      logsWriter.flush(() => {
        expect(logErrorSpy.called).to.be.true
        scope.done()
        done()
      })
    })
  })

  context('agent based', () => {
    it('can send logs to the debugger endpoint in the agent', (done) => {
      delete process.env.DD_API_KEY

      const scope = nock('http://www.example.com')
        .post('/debugger/v1/input', body => {
          expect(body).to.deep.equal([{ message: 'test3' }, { message: 'test4' }])
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
      delete process.env.DD_API_KEY

      const logErrorSpy = sinon.spy(log, 'error')

      const scope = nock('http://www.example.com')
        .post('/debugger/v1/input')
        .reply(500)

      const logsWriter = new DynamicInstrumentationLogsWriter({ url: 'http://www.example.com', isAgentProxy: true })

      logsWriter.append({ message: 'test5' })
      logsWriter.append({ message: 'test6' })

      logsWriter.flush(() => {
        expect(logErrorSpy.called).to.be.true
        scope.done()
        done()
      })
    })
  })
})
