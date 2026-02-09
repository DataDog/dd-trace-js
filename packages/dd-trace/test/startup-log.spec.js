'use strict'

const assert = require('node:assert')
const os = require('node:os')

const { describe, it, before } = require('mocha')
const sinon = require('sinon')

require('./setup/core')
const SamplingRule = require('../src/sampling_rule')
const tracerVersion = require('../../../package.json').version
const { getConfigFresh } = require('./helpers/config')

describe('startup logging', () => {
  let firstStderrCall
  let secondStderrCall
  let tracerInfoMethod

  before(() => {
    sinon.stub(console, 'error')
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      setSamplingRules,
      startupLog,
      tracerInfo,
    } = require('../src/startup-log')
    tracerInfoMethod = tracerInfo
    setStartupLogPluginManager({
      _pluginsByName: {
        http: { _enabled: true },
        fs: { _enabled: true },
        semver: { _enabled: true },
      },
    })
    setStartupLogConfig({
      env: 'production',
      enabled: true,
      scope: 'async_hooks',
      service: 'test',
      hostname: 'example.com',
      port: 4321,
      debug: true,
      sampler: {
        sampleRate: 1,
      },
      tags: { version: '1.2.3', invalid_but_listed_due_to_mocking: 42n },
      logInjection: true,
      runtimeMetrics: true,
      startupLogs: true,
      appsec: { enabled: true },
      dsmEnabled: true,
    })
    setSamplingRules([
      new SamplingRule({ name: 'rule1', sampleRate: 0.4 }),
      'rule2',
      new SamplingRule({ name: 'rule3', sampleRate: 1.4 }),
    ])
    // Use sinon's stub instance directly to avoid type errors
    // eslint-disable-next-line no-console
    const errorStub = /** @type {sinon.SinonStub} */ (console.error)
    // eslint-disable-next-line no-console
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    startupLog({ message: 'Error: fake error' })
    firstStderrCall = errorStub.firstCall
    secondStderrCall = warnStub.firstCall
    errorStub.restore()
    warnStub.restore()
  })

  it('startupLog should be formatted correctly', () => {
    assert.strictEqual(firstStderrCall.args[0].startsWith('DATADOG TRACER CONFIGURATION - '), true)
    const info = JSON.parse(String(tracerInfoMethod()))
    assert.deepStrictEqual(info, {
      date: info.date,
      os_name: os.type(),
      os_version: os.release(),
      architecture: os.arch(),
      version: tracerVersion,
      lang: 'nodejs',
      lang_version: process.versions.node,
      env: 'production',
      enabled: true,
      service: 'test',
      agent_url: 'http://example.com:4321/',
      debug: true,
      sample_rate: 1,
      sampling_rules: [
        { matchers: [{ pattern: 'rule1' }], _sampler: { _rate: 0.4 } },
        'rule2',
        { matchers: [{ pattern: 'rule3' }], _sampler: { _rate: 1 } },
      ],
      tags: { version: '1.2.3', invalid_but_listed_due_to_mocking: '42' },
      dd_version: '1.2.3',
      log_injection_enabled: true,
      runtime_metrics_enabled: true,
      profiling_enabled: false,
      integrations_loaded: ['http', 'fs', 'semver'],
      appsec_enabled: true,
      data_streams_enabled: true,
    })
  })

  it('startupLog should correctly also output the diagnostic message', () => {
    assert.strictEqual(secondStderrCall.args[0], 'DATADOG TRACER DIAGNOSTIC - Agent Error: Error: fake error')
  })
})

describe('data_streams_enabled', () => {
  afterEach(() => {
    delete process.env.DD_DATA_STREAMS_ENABLED
  })

  it('should be true when env var is true and config is unset', () => {
    sinon.stub(console, 'info')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      startupLog,
    } = require('../src/startup-log')
    process.env.DD_DATA_STREAMS_ENABLED = 'true'
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh())
    setStartupLogPluginManager({ _pluginsByName: {} })
    startupLog()
    /* eslint-disable-next-line no-console */
    const infoStub = /** @type {sinon.SinonStub} */ (console.info)
    const logObj = JSON.parse(infoStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    infoStub.restore()
    assert.strictEqual(logObj.data_streams_enabled, true)
  })

  it('should be true when env var is not set and config is true', () => {
    sinon.stub(console, 'info')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      startupLog,
    } = require('../src/startup-log')
    delete process.env.DD_DATA_STREAMS_ENABLED
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh({ dsmEnabled: true }))
    setStartupLogPluginManager({ _pluginsByName: {} })
    startupLog()
    /* eslint-disable-next-line no-console */
    const infoStub = /** @type {sinon.SinonStub} */ (console.info)
    const logObj = JSON.parse(infoStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    infoStub.restore()
    assert.strictEqual(logObj.data_streams_enabled, true)
  })

  it('should be false when env var is true but config is false', () => {
    sinon.stub(console, 'info')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      startupLog,
    } = require('../src/startup-log')
    process.env.DD_DATA_STREAMS_ENABLED = 'true'
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh({ dsmEnabled: false }))
    setStartupLogPluginManager({ _pluginsByName: {} })
    startupLog()
    /* eslint-disable-next-line no-console */
    const infoStub = /** @type {sinon.SinonStub} */ (console.info)
    const logObj = JSON.parse(infoStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    infoStub.restore()
    assert.strictEqual(logObj.data_streams_enabled, false)
  })
})

describe('profiling_enabled', () => {
  it('should be correctly logged', () => {
    [
      ['undefined', false],
      ['false', false],
      ['FileNotFound', false],
      ['auto', true],
      ['true', true],
    ].forEach(([envVar, expected]) => {
      sinon.stub(console, 'error')
      delete require.cache[require.resolve('../src/startup-log')]
      const {
        setStartupLogConfig,
        setStartupLogPluginManager,
        startupLog,
      } = require('../src/startup-log')
      process.env.DD_PROFILING_ENABLED = envVar
      process.env.DD_TRACE_STARTUP_LOGS = 'true'
      setStartupLogConfig(getConfigFresh())
      setStartupLogPluginManager({ _pluginsByName: {} })
      startupLog()
      /* eslint-disable-next-line no-console */
      const errorStub = /** @type {sinon.SinonStub} */ (console.error)
      const logObj = JSON.parse(errorStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
      errorStub.restore()
      assert.strictEqual(logObj.profiling_enabled, expected)
    })
  })
})
