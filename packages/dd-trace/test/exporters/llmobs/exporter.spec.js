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
  let selectStrategy
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

    Exporter = proxyquire('../../../src/exporters/llmobs', {
      '../agent': AgentExporter,
      '../agentless': AgentlessExporter,
      '../../llmobs/writers/util': {
        setAgentStrategy: sinon.stub().callsFake((config, callback) => { selectStrategy = callback }),
      },
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

  it('buffers traces and drains them to the Agent exporter when selected', () => {
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    assert.strictEqual(exporter.export(trace), true)
    sinon.assert.notCalled(AgentExporter)

    selectStrategy(false)

    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('buffers traces and drains them to the agentless exporter when selected', () => {
    const config = getConfig()
    const prioritySampler = {}
    const exporter = new Exporter(config, prioritySampler)
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)
    selectStrategy(true, false)

    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(agentlessExporter.export, trace)
    sinon.assert.notCalled(agentlessExporter.setUrl)
    sinon.assert.notCalled(AgentExporter)
  })

  it('uses the Agent exporter when the Agent is available without the LLMObs EVP endpoint', () => {
    const config = getConfig()
    const exporter = new Exporter(config, {})
    const trace = [{ name: 'llm.request' }]

    exporter.export(trace)
    selectStrategy(true, true)

    sinon.assert.calledOnce(AgentExporter)
    sinon.assert.calledOnceWithExactly(agentExporter.export, trace)
    sinon.assert.notCalled(AgentlessExporter)
  })

  it('applies a URL set before transport selection to the selected exporter', () => {
    const exporter = new Exporter(getConfig(), {})
    const url = new URL('http://custom-agent:8126')

    exporter.setUrl(url)
    selectStrategy(false)

    sinon.assert.calledOnceWithExactly(agentExporter.setUrl, url)
  })
})
