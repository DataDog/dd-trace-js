'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('./setup/core')
const AgentExporter = require('../src/exporters/agent')
const LogExporter = require('../src/exporters/log')
const ElectronExporter = require('../src/exporters/electron')
const { DATADOG_MINI_AGENT_PATH } = require('../src/constants')

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
    const createExporter = require('../src/exporter')
    const Exporter = createExporter()

    assert.strictEqual(Exporter, AgentExporter)
  })

  it('should create an LogExporter when in Lambda environment', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    const createExporter = require('../src/exporter')
    const Exporter = createExporter()

    assert.strictEqual(Exporter, LogExporter)
  })

  it('should report the Lambda log transport so OTel semantics cannot replace it', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    // The only route to the backend from there, so the forced OTLP export has to leave it alone.
    assert.strictEqual(require('../src/exporter').usesLambdaLogExporter(), true)
  })

  it('should not report the Lambda log transport when an agent is present', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs(DATADOG_MINI_AGENT_PATH).returns(true)

    assert.strictEqual(require('../src/exporter').usesLambdaLogExporter(), false)
    stub.restore()
  })

  it('should not report the Lambda log transport outside Lambda', () => {
    assert.strictEqual(require('../src/exporter').usesLambdaLogExporter(), false)
  })

  it('should require the Lambda log transport when no OTLP collector was configured', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    assert.strictEqual(require('../src/exporter').requiresLambdaLogExporter(), true)
  })

  it('should require the Lambda log transport when configured OTLP endpoints are empty', () => {
    for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
      process.env[key] = ''

      assert.strictEqual(require('../src/exporter').requiresLambdaLogExporter(), true, key)
      delete process.env[key]
    }
  })

  it('should yield to either explicitly configured OTLP endpoint in Lambda', () => {
    // `createOtlpTraceExporter` reads the trace-specific one, so both have to count.
    for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
      process.env[key] = 'http://collector:4318'

      assert.strictEqual(require('../src/exporter').requiresLambdaLogExporter(), false, key)
      delete process.env[key]
    }
  })

  it('should create an AgentExporter when in Lambda environment with an extension', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs('/opt/extensions/datadog-agent').returns(true)

    const createExporter = require('../src/exporter')
    const Exporter = createExporter()

    assert.strictEqual(Exporter, AgentExporter)
    stub.restore()
  })

  it('should create an AgentExporter when in Lambda environment with mini agent', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs(DATADOG_MINI_AGENT_PATH).returns(true)

    const createExporter = require('../src/exporter')
    const Exporter = createExporter()

    assert.strictEqual(Exporter, AgentExporter)
    stub.restore()
  })

  it('should allow configuring the exporter', () => {
    const createExporter = require('../src/exporter')
    const Exporter = createExporter('log')

    assert.strictEqual(Exporter, LogExporter)
  })

  it('should create an ElectronExporter when configured', () => {
    const createExporter = require('../src/exporter')
    const Exporter = createExporter('electron')

    assert.strictEqual(Exporter, ElectronExporter)
  })
})
