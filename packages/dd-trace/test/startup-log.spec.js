'use strict'

const assert = require('node:assert')
const os = require('node:os')

const { describe, it, before, afterEach } = require('mocha')
const sinon = require('sinon')

require('./setup/core')
const SamplingRule = require('../src/sampling_rule')
const tracerVersion = require('../../../package.json').version
const { getConfigFresh } = require('./helpers/config')

const configWithStartupLogs = {
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
}

const testSamplingRules = [
  new SamplingRule({ name: 'rule1', sampleRate: 0.4 }),
  'rule2',
  new SamplingRule({ name: 'rule3', sampleRate: 1.4 }),
]

describe('startup logging', () => {
  let warnStub
  let tracerInfoMethod

  before(() => {
    warnStub = sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      setSamplingRules,
      startupLog,
      logIntegrations,
      logAgentError,
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
    setStartupLogConfig(configWithStartupLogs)
    setSamplingRules(testSamplingRules)
    startupLog()
    logIntegrations()
    logAgentError({ status: 500, message: 'Error: fake error' })
  })

  after(() => warnStub.restore())

  it('startupLog should output config without integrations_loaded', () => {
    const logLine = warnStub.firstCall.args[0]
    assert.strictEqual(logLine.startsWith('DATADOG TRACER CONFIGURATION - '), true)
    const logObj = JSON.parse(logLine.replace('DATADOG TRACER CONFIGURATION - ', ''))
    assert.strictEqual('integrations_loaded' in logObj, false)
    assert.strictEqual(logObj.env, 'production')
    assert.strictEqual(logObj.enabled, true)
    assert.strictEqual(logObj.service, 'test')
    assert.strictEqual(logObj.debug, true)
    assert.strictEqual(logObj.appsec_enabled, true)
    assert.strictEqual(logObj.data_streams_enabled, true)
  })

  it('logIntegrations should output loaded integrations', () => {
    const logLine = warnStub.secondCall.args[0]
    assert.strictEqual(logLine, 'DATADOG TRACER INTEGRATIONS LOADED - ["http","fs","semver"]')
  })

  it('logAgentError should output diagnostic message', () => {
    const logLine = warnStub.thirdCall.args[0]
    assert.strictEqual(logLine, 'DATADOG TRACER DIAGNOSTIC - Agent Error: Error: fake error')
  })

  it('tracerInfo should include integrations_loaded', () => {
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
        { matchers: [{ pattern: 'rule1' }] },
        'rule2',
        { matchers: [{ pattern: 'rule3' }] },
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
})

describe('startupLog should not include integrations_loaded (regression #7470)', () => {
  it('should not include integrations_loaded when pluginManager is not yet set', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      startupLog,
    } = require('../src/startup-log')
    // Simulate the #7470 scenario: startupLog fires at init before pluginManager is set
    setStartupLogConfig(configWithStartupLogs)
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    warnStub.restore()
    assert.strictEqual('integrations_loaded' in logObj, false)
  })

  it('should not include integrations_loaded even when pluginManager is set', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      startupLog,
    } = require('../src/startup-log')
    // Even with pluginManager available, config log should not include integrations
    setStartupLogPluginManager({ _pluginsByName: { http: {}, fs: {} } })
    setStartupLogConfig(configWithStartupLogs)
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    warnStub.restore()
    assert.strictEqual('integrations_loaded' in logObj, false)
  })
})

describe('startup log guards', () => {
  it('startupLog should only run once', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const { setStartupLogConfig, startupLog } = require('../src/startup-log')
    setStartupLogConfig(configWithStartupLogs)
    startupLog()
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    assert.strictEqual(warnStub.callCount, 1)
    warnStub.restore()
  })

  it('logIntegrations should only run once', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const { setStartupLogConfig, setStartupLogPluginManager, logIntegrations } = require('../src/startup-log')
    setStartupLogConfig(configWithStartupLogs)
    setStartupLogPluginManager({ _pluginsByName: { http: {} } })
    logIntegrations()
    logIntegrations()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    assert.strictEqual(warnStub.callCount, 1)
    warnStub.restore()
  })

  it('logAgentError should only run once', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const { setStartupLogConfig, logAgentError } = require('../src/startup-log')
    setStartupLogConfig(configWithStartupLogs)
    logAgentError({ status: 500, message: 'err1' })
    logAgentError({ status: 503, message: 'err2' })
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    assert.strictEqual(warnStub.callCount, 1)
    assert.strictEqual(warnStub.firstCall.args[0], 'DATADOG TRACER DIAGNOSTIC - Agent Error: err1')
    warnStub.restore()
  })

  it('should not log when startupLogs is false', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      startupLog,
      logIntegrations,
      logAgentError,
    } = require('../src/startup-log')
    setStartupLogConfig({ ...configWithStartupLogs, startupLogs: false })
    setStartupLogPluginManager({ _pluginsByName: { http: {} } })
    startupLog()
    logIntegrations()
    logAgentError({ status: 500, message: 'err' })
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    assert.strictEqual(warnStub.callCount, 0)
    warnStub.restore()
  })
})

describe('data_streams_enabled', () => {
  afterEach(() => {
    delete process.env.DD_DATA_STREAMS_ENABLED
  })

  it('should be true when env var is true and config is unset', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      startupLog,
    } = require('../src/startup-log')
    process.env.DD_DATA_STREAMS_ENABLED = 'true'
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh())
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    warnStub.restore()
    assert.strictEqual(logObj.data_streams_enabled, true)
  })

  it('should be true when env var is not set and config is true', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      startupLog,
    } = require('../src/startup-log')
    delete process.env.DD_DATA_STREAMS_ENABLED
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh({ dsmEnabled: true }))
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    warnStub.restore()
    assert.strictEqual(logObj.data_streams_enabled, true)
  })

  it('should be false when env var is true but config is false', () => {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      startupLog,
    } = require('../src/startup-log')
    process.env.DD_DATA_STREAMS_ENABLED = 'true'
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh({ dsmEnabled: false }))
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    warnStub.restore()
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
      sinon.stub(console, 'warn')
      delete require.cache[require.resolve('../src/startup-log')]
      const {
        setStartupLogConfig,
        startupLog,
      } = require('../src/startup-log')
      process.env.DD_PROFILING_ENABLED = envVar
      process.env.DD_TRACE_STARTUP_LOGS = 'true'
      setStartupLogConfig(getConfigFresh())
      startupLog()
      /* eslint-disable-next-line no-console */
      const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
      const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
      warnStub.restore()
      assert.strictEqual(logObj.profiling_enabled, expected)
    })
  })
})
