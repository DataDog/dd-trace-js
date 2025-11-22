'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')

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
  const port = 8126
  const url = `http://127.0.0.1:${port}`

  it('should query /info when getAgentInfo is called', (done) => {
    const scope = nock(url)
      .get('/info')
      .reply(200, JSON.stringify({
        endpoints: ['/evp_proxy/v2']
      }))

    const agentInfoExporter = new AgentInfoExporter({ port })
    assert.notStrictEqual(scope.isDone(), true)
    agentInfoExporter.getAgentInfo((err, { endpoints }) => {
      assert.strictEqual(err, null)
      assertObjectContains(endpoints, '/evp_proxy/v2')
      assert.strictEqual(scope.isDone(), true)
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
    const agentInfoExporter = new AgentInfoExporter({ port })

    agentInfoExporter.export(trace)

    assertObjectContains(agentInfoExporter.getUncodedTraces(), trace)

    agentInfoExporter.getAgentInfo(() => {
      assertObjectContains(agentInfoExporter.getUncodedTraces(), trace)
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
    const agentInfoExporter = new AgentInfoExporter({ port, flushInterval })

    agentInfoExporter.getAgentInfo(() => {
      agentInfoExporter._writer = writer
      agentInfoExporter._isInitialized = true
      agentInfoExporter.export(trace)
      sinon.assert.calledWith(writer.append, trace)
      sinon.assert.notCalled(writer.flush)
      expect(agentInfoExporter.getUncodedTraces()).not.to.include(trace)
      setTimeout(() => {
        sinon.assert.called(writer.flush)
        done()
      }, flushInterval)
    })
  })
})
