'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const sinon = require('sinon')
const nock = require('nock')

require('../../setup/core')

const AgentInfoExporter = require('../../../src/exporters/common/agent-info-exporter')

describe('AgentInfoExporter', () => {
  const writer = {
    append: sinon.spy(),
    flush: sinon.spy(),
    setUrl: sinon.spy()
  }
  const flushInterval = 100
  const url = 'http://127.0.0.1:8126'

  it('should query /info when getAgentInfo is called', (done) => {
    const scope = nock(url)
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentInfoExporter = new AgentInfoExporter({ url })
    expect(scope.isDone()).not.to.be.true
    agentInfoExporter.getAgentInfo((err, { endpoints }) => {
      expect(err).to.be.null
      expect(endpoints).to.include('/evp_proxy/v2')
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should store traces as is when export is called', (done) => {
    nock(url)
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))
    const trace = [{ span_id: '1234' }]
    const agentInfoExporter = new AgentInfoExporter({ url })

    agentInfoExporter.export(trace)

    expect(agentInfoExporter.getUncodedTraces()).to.include(trace)

    agentInfoExporter.getAgentInfo(() => {
      expect(agentInfoExporter.getUncodedTraces()).to.include(trace)
      done()
    })
  })

  it('should export if a writer is initialized', (done) => {
    nock(url)
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const trace = [{ span_id: '1234' }]
    const agentInfoExporter = new AgentInfoExporter({ url, flushInterval })

    agentInfoExporter.getAgentInfo(() => {
      agentInfoExporter._writer = writer
      agentInfoExporter._isInitialized = true
      agentInfoExporter.export(trace)
      expect(writer.append).to.have.been.calledWith(trace)
      expect(writer.flush).not.to.have.been.called
      expect(agentInfoExporter.getUncodedTraces()).not.to.include(trace)
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
        done()
      }, flushInterval)
    })
  })
})
