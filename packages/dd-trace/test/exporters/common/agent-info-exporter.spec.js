'use strict'

const t = require('tap')
require('../../setup/core')

const AgentInfoExporter = require('../../../src/exporters/common/agent-info-exporter')
const nock = require('nock')

t.test('AgentInfoExporter', t => {
  const writer = {
    append: sinon.spy(),
    flush: sinon.spy(),
    setUrl: sinon.spy()
  }
  const flushInterval = 100
  const port = 8126

  t.test('should query /info when getAgentInfo is called', (t) => {
    const scope = nock('http://localhost:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentInfoExporter = new AgentInfoExporter({ port })
    expect(scope.isDone()).not.to.be.true
    agentInfoExporter.getAgentInfo((err, { endpoints }) => {
      expect(err).to.be.null
      expect(endpoints).to.include('/evp_proxy/v2')
      expect(scope.isDone()).to.be.true
      t.end()
    })
  })

  t.test('should store traces as is when export is called', (t) => {
    nock('http://localhost:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))
    const trace = [{ span_id: '1234' }]
    const agentInfoExporter = new AgentInfoExporter({ port })

    agentInfoExporter.export(trace)

    expect(agentInfoExporter.getUncodedTraces()).to.include(trace)

    agentInfoExporter.getAgentInfo(() => {
      expect(agentInfoExporter.getUncodedTraces()).to.include(trace)
      t.end()
    })
  })

  t.test('should export if a writer is initialized', (t) => {
    nock('http://localhost:8126')
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const trace = [{ span_id: '1234' }]
    const agentInfoExporter = new AgentInfoExporter({ port, flushInterval })

    agentInfoExporter.getAgentInfo(() => {
      agentInfoExporter._writer = writer
      agentInfoExporter._isInitialized = true
      agentInfoExporter.export(trace)
      expect(writer.append).to.have.been.calledWith(trace)
      expect(writer.flush).not.to.have.been.called
      expect(agentInfoExporter.getUncodedTraces()).not.to.include(trace)
      setTimeout(() => {
        expect(writer.flush).to.have.been.called
        t.end()
      }, flushInterval)
    })
  })
  t.end()
})
