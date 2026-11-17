'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('./setup/core')
const AgentExporter = require('../src/exporters/agent')
const LLMObsExporter = require('../src/exporters/llmobs')
const LogExporter = require('../src/exporters/log')
const ElectronExporter = require('../src/exporters/electron')
const { DATADOG_LAMBDA_EXTENSION_PATH, DATADOG_MINI_AGENT_PATH } = require('../src/constants')

describe('exporter', () => {
  let env

  beforeEach(() => {
    env = process.env
    process.env = {}
    delete require.cache[require.resolve('../src/serverless')]
  })

  afterEach(() => {
    process.env = env
  })

  it('should create an AgentExporter by default', () => {
    const createExporter = require('../src/exporter')
    const Exporter = createExporter()

    assert.strictEqual(Exporter, AgentExporter)
  })

  it('should create an LLMObsExporter when configured', () => {
    const createExporter = require('../src/exporter')
    const Exporter = createExporter('llmobs')

    assert.strictEqual(Exporter, LLMObsExporter)
  })

  it('should create an LogExporter when in Lambda environment', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'

    const createExporter = require('../src/exporter')
    const Exporter = createExporter()

    assert.strictEqual(Exporter, LogExporter)
  })

  it('should preserve the LogExporter for LLMObs in Lambda without an agent', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync').returns(false)

    const createExporter = require('../src/exporter')
    const Exporter = createExporter('llmobs')

    assert.strictEqual(Exporter, LogExporter)
    sinon.assert.calledWith(stub, DATADOG_LAMBDA_EXTENSION_PATH)
    sinon.assert.calledWith(stub, DATADOG_MINI_AGENT_PATH)
    stub.restore()
  })

  it('should create an LLMObsExporter in Lambda with an extension', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs(DATADOG_LAMBDA_EXTENSION_PATH).returns(true)

    const createExporter = require('../src/exporter')
    const Exporter = createExporter('llmobs')

    assert.strictEqual(Exporter, LLMObsExporter)
    stub.restore()
  })

  it('should create an LLMObsExporter in Lambda with a mini agent', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-func'
    const stub = sinon.stub(fs, 'existsSync')
    stub.withArgs(DATADOG_MINI_AGENT_PATH).returns(true)

    const createExporter = require('../src/exporter')
    const Exporter = createExporter('llmobs')

    assert.strictEqual(Exporter, LLMObsExporter)
    stub.restore()
  })

  describe('usesOtlpTraceExporter', () => {
    function config (overrides = {}) {
      return {
        OTEL_TRACES_EXPORTER: 'otlp',
        isCiVisibility: false,
        tracing: { DD_TRACE_EXPERIMENTAL_EXPORTER: '' },
        ...overrides,
      }
    }

    it('should select OTLP when requested without a transport exception', () => {
      assert.strictEqual(require('../src/exporter').usesOtlpTraceExporter(config()), true)
    })

    it('should not select OTLP when it is not requested', () => {
      assert.strictEqual(
        require('../src/exporter').usesOtlpTraceExporter(config({ OTEL_TRACES_EXPORTER: 'none' })),
        false
      )
    })

    it('should not select OTLP for Test Optimization', () => {
      assert.strictEqual(require('../src/exporter').usesOtlpTraceExporter(config({ isCiVisibility: true })), false)
    })

    it('should not select OTLP for Electron', () => {
      const electronConfig = config({ tracing: { DD_TRACE_EXPERIMENTAL_EXPORTER: 'electron' } })
      assert.strictEqual(require('../src/exporter').usesOtlpTraceExporter(electronConfig), false)
    })

    it('should not select OTLP for agentless tracing', () => {
      const agentlessConfig = config({ tracing: { DD_TRACE_EXPERIMENTAL_EXPORTER: 'agentless' } })
      assert.strictEqual(require('../src/exporter').usesOtlpTraceExporter(agentlessConfig), false)
    })
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
