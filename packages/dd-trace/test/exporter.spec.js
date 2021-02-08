'use strict'

const AgentExporter = require('../src/exporters/agent')
const LogExporter = require('../src/exporters/log')

describe('exporter', () => {
  let env

  beforeEach(() => {
    env = process.env
    process.env = {}
  })

  afterEach(() => {
    process.env = env
  })

  it('should create an AgentExporter by default', () => {
    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(AgentExporter)
  })

  it('should create an LogExporter when in Lambda environment', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(LogExporter)
  })

  it('should allow configuring the exporter', () => {
    const Exporter = require('../src/exporter')('log')

    expect(Exporter).to.be.equal(LogExporter)
  })
})
