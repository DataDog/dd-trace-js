'use strict'

const AgentExporter = require('../src/exporters/agent')
const LogExporter = require('../src/exporters/log')

describe('exporter', () => {
  let platform

  beforeEach(() => {
    platform = {
      env: sinon.stub()
    }
  })

  it('should create an AgentExporter by default', () => {
    const Exporter = proxyquire('../src/exporter', {
      './platform': platform
    })()

    expect(Exporter).to.be.equal(AgentExporter)
  })

  it('should create an LogExporter when in Lambda environment', () => {
    platform.env.withArgs('AWS_LAMBDA_FUNCTION_NAME').returns('my-func')

    const Exporter = proxyquire('../src/exporter', {
      './platform': platform
    })()

    expect(Exporter).to.be.equal(LogExporter)
  })

  it('should allow configuring the exporter', () => {
    const Exporter = proxyquire('../src/exporter', {
      './platform': platform
    })('log')

    expect(Exporter).to.be.equal(LogExporter)
  })
})
