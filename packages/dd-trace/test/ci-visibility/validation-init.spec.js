'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('Test Optimization validation initialization', () => {
  it('resolves the private exporter instead of agent-proxy or agentless exporters', () => {
    const offlineExporter = {}
    const agentProxyExporter = {}
    const agentlessExporter = {}
    const getExporter = proxyquire('../../src/exporter', {
      './ci-visibility/exporters/agent-proxy': agentProxyExporter,
      './ci-visibility/exporters/agentless': agentlessExporter,
      './ci-visibility/exporters/ci-validation': offlineExporter,
    })

    const selected = getExporter('ci_validation')

    assert.strictEqual(selected, offlineExporter)
    assert.notStrictEqual(selected, agentProxyExporter)
    assert.notStrictEqual(selected, agentlessExporter)
  })

  it('selects the offline exporter without an API key and ahead of agentless configuration', () => {
    const tracer = {
      init: sinon.stub(),
      use: sinon.stub(),
    }
    const values = {
      DD_CIVISIBILITY_AGENTLESS_ENABLED: true,
      DD_CIVISIBILITY_ENABLED: false,
      DD_API_KEY: 'must-not-select-agentless',
    }

    proxyquire('../../../../ci/init', {
      '../packages/dd-trace': tracer,
      '../packages/dd-trace/src/config/helper': {
        getEnvironmentVariable: name => name === '_DD_TEST_OPTIMIZATION_VALIDATION_MODE' ? '1' : undefined,
        getValueFromEnvSources: (name, skipDefault) => values[name] ?? skipDefault,
      },
      '../packages/dd-trace/src/log': { debug: sinon.stub() },
      '../packages/dd-trace/src/util': {
        isFalse: value => value === 'false' || value === '0',
        isTrue: value => value === '1',
      },
    })

    assert.strictEqual(tracer.init.callCount, 1)
    assert.deepStrictEqual(tracer.init.firstCall.args[0], {
      startupLogs: false,
      isCiVisibility: true,
      flushInterval: 5000,
      telemetry: { enabled: false },
      experimental: { exporter: 'ci_validation' },
    })
  })

  it('preserves an explicit CI instruction to disable Test Optimization', () => {
    const tracer = {
      init: sinon.stub(),
      use: sinon.stub(),
    }

    proxyquire('../../../../ci/init', {
      '../packages/dd-trace': tracer,
      '../packages/dd-trace/src/config/helper': {
        getEnvironmentVariable: name => ({
          DD_CIVISIBILITY_ENABLED: 'false',
          _DD_TEST_OPTIMIZATION_VALIDATION_MODE: '1',
        })[name],
        getValueFromEnvSources: () => undefined,
      },
      '../packages/dd-trace/src/log': { debug: sinon.stub() },
      '../packages/dd-trace/src/util': {
        isFalse: value => value === 'false' || value === '0',
        isTrue: value => value === '1',
      },
    })

    assert.strictEqual(tracer.init.callCount, 0)
  })

  it('does not create sockets while initializing a validation test worker', () => {
    const initPath = path.resolve(__dirname, '../../../../ci/init.js')
    const script = [
      "const fail = () => { process.exitCode = 97; throw new Error('validation worker attempted network') }",
      "for (const name of ['node:http', 'node:https']) {",
      '  const client = require(name)',
      '  client.get = fail',
      '  client.request = fail',
      '}',
      "const net = require('node:net')",
      'net.connect = fail',
      'net.createConnection = fail',
      'net.createServer = fail',
      "require('node:tls').connect = fail",
      "require('node:dgram').createSocket = fail",
      `require(${JSON.stringify(initPath)})`,
    ].join('\n')
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        MOCHA_WORKER_ID: '1',
        NODE_OPTIONS: '',
        _DD_TEST_OPTIMIZATION_VALIDATION_MODE: '1',
      },
    })

    assert.strictEqual(child.status, 0, child.stderr)
    assert.doesNotMatch(child.stderr, /validation worker attempted network/)
  })
})
