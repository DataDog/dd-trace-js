'use strict'
const fs = require('fs')

const AgentExporter = require('../src/exporters/agent')
const LogExporter = require('../src/exporters/log')
const JaegerExporter = require('../src/exporters/jaeger')

describe('exporter', () => {
  let env

  beforeEach(() => {
    env = process.env
    process.env = {}
  })

  afterEach(() => {
    process.env = env
  })

  it('should create an JaegerExporter by default', () => {
    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(JaegerExporter)
  })

  it('should create an LogExporter when in Lambda environment', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(LogExporter)
  })

  it('should create an AgentExporter when in Lambda environment with an extension', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs('/opt/extensions/datadog-agent').returns(true)

    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(AgentExporter)
    stub.restore()
  })

  it('should allow configuring the exporter', () => {
    const Exporter = require('../src/exporter')('log')

    expect(Exporter).to.be.equal(LogExporter)
  })
  it('should allow configuring the exporter', () => {
    const Exporter = require('../src/exporter')('jaeger')

    expect(Exporter).to.be.equal(JaegerExporter)
  })
})
