'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('LLMObsExporter', () => {
  let AgentExporter
  let AgentlessExporter
  let agentExporter
  let agentlessExporter
  let fetchAgentInfo
  let getValueFromEnvSources
  let Exporter

  beforeEach(() => {
    agentExporter = {
      _url: new URL('http://agent:8126'),
      export: sinon.stub().returns(true),
      flush: sinon.stub().callsFake(done => done?.()),
      setUrl: sinon.stub(),
    }
    agentlessExporter = {
      _url: new URL('https://intake.example'),
      export: sinon.stub().returns(true),
      flush: sinon.stub().callsFake(done => done?.()),
      setUrl: sinon.stub(),
    }
    AgentExporter = sinon.stub().returns(agentExporter)
    AgentlessExporter = sinon.stub().returns(agentlessExporter)
    fetchAgentInfo = sinon.stub()
    getValueFromEnvSources = sinon.stub().returns(undefined)

    Exporter = proxyquire('../../../src/exporters/llmobs', {
      '../../agent/info': { fetchAgentInfo },
      '../../config/helper': { getValueFromEnvSources },
      '../agent': AgentExporter,
      '../agentless': AgentlessExporter,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  function getConfig () {
    return {
      llmobs: {},
      url: new URL('http://agent:8126'),
    }
  }

  it('buffers traces and drains them to the Agent exporter when discovery succeeds', () => {
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    assert.strictEqual(exporter.export(trace), true)
    sinon.assert.notCalled(AgentExporter)
    sinon.assert.calledOnceWithExactly(getValueFromEnvSources, 'DD_AGENTLESS_ENABLED', true)
    sinon.assert.calledOnceWithExactly(fetchAgentInfo, config.url, sinon.match.func, { retry: false })

    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('buffers traces and drains them to the agentless exporter when discovery fails', () => {
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)
    fetchAgentInfo.yield(new Error('Agent unavailable'))

    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentlessExporter.export, trace)
    sinon.assert.notCalled(agentlessExporter.setUrl)
    sinon.assert.notCalled(AgentExporter)
  })

  it('uses the agentless exporter immediately when global agentless mode is explicitly enabled', () => {
    getValueFromEnvSources.returns(true)
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)

    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentlessExporter.export, trace)
    sinon.assert.notCalled(fetchAgentInfo)
    sinon.assert.notCalled(AgentExporter)
  })

  it('uses the Agent exporter immediately when global agentless mode is explicitly disabled', () => {
    getValueFromEnvSources.returns(false)
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)

    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(fetchAgentInfo)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('applies a URL set before transport selection to the selected exporter', () => {
    const exporter = new Exporter(getConfig(), {})
    const url = new URL('http://custom-agent:8126')

    exporter.setUrl(url)
    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.calledOnceWithExactly(agentExporter.setUrl, url)
  })

  it('waits for transport selection before completing a flush', () => {
    const exporter = new Exporter(getConfig(), {})
    const trace = [{ name: 'llm.request' }]
    const done = sinon.spy()

    exporter.export(trace)
    exporter.flush(done)

    sinon.assert.notCalled(done)
    sinon.assert.notCalled(agentExporter.flush)

    fetchAgentInfo.yield(null, { endpoints: [] })

    sinon.assert.callOrder(agentExporter.export, agentExporter.flush)
    sinon.assert.calledOnceWithExactly(agentExporter.flush, done)
    sinon.assert.calledOnce(done)
  })
})
