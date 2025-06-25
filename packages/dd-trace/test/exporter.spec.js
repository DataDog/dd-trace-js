'use strict'

const t = require('tap')
require('./setup/core')

const fs = require('fs')

const AgentExporter = require('../src/exporters/agent')
const LogExporter = require('../src/exporters/log')

t.test('exporter', t => {
  let env

  t.beforeEach(() => {
    env = process.env
    process.env = {}
  })

  t.afterEach(() => {
    process.env = env
  })

  t.test('should create an AgentExporter by default', t => {
    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(AgentExporter)
    t.end()
  })

  t.test('should create an LogExporter when in Lambda environment', t => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(LogExporter)
    t.end()
  })

  t.test('should create an AgentExporter when in Lambda environment with an extension', t => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs('/opt/extensions/datadog-agent').returns(true)

    const Exporter = require('../src/exporter')()

    expect(Exporter).to.be.equal(AgentExporter)
    stub.restore()
    t.end()
  })

  t.test('should allow configuring the exporter', t => {
    const Exporter = require('../src/exporter')('log')

    expect(Exporter).to.be.equal(LogExporter)
    t.end()
  })
  t.end()
})
