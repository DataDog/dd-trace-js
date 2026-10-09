'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')

const { describe, it, before, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('./setup/core')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const SamplingRule = require('../src/sampling_rule')
const tracerVersion = require('../../../package.json').version
const { getConfigFresh } = require('./helpers/config')

const configWithStartupLogs = {
  env: 'production',
  enabled: true,
  scope: 'async_hooks',
  service: 'test',
  url: new URL('http://example.com:4321/'),
  debug: true,
  sampler: {
    sampleRate: 1,
  },
  tags: { version: '1.2.3', invalid_but_listed_due_to_mocking: 42n },
  logInjection: true,
  runtimeMetrics: true,
  startupLogs: true,
  appsec: { DD_APPSEC_ENABLED: true },
  profiling: { DD_PROFILING_ENABLED: false },
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
    assert.strictEqual('otlp_traces_export_enabled' in logObj, true)
    assert.strictEqual('otlp_metrics_export_enabled' in logObj, true)
    assert.strictEqual('otlp_logs_export_enabled' in logObj, true)
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
        { matchers: [{ pattern: 'rule1' }], _sampler: { _rate: 0.4 }, discard: false },
        'rule2',
        { matchers: [{ pattern: 'rule3' }], _sampler: { _rate: 1 }, discard: false },
      ],
      tags: { version: '1.2.3', invalid_but_listed_due_to_mocking: '42' },
      dd_version: '1.2.3',
      log_injection_enabled: true,
      runtime_metrics_enabled: true,
      profiling_enabled: false,
      integrations_loaded: ['http', 'fs', 'semver'],
      appsec_enabled: true,
      data_streams_enabled: true,
      otlp_traces_export_enabled: false,
      otlp_metrics_export_enabled: false,
      otlp_logs_export_enabled: false,
      DD_AGENT_HOST: null,
      DD_DATA_STREAMS_ENABLED: true,
      DD_DBM_PROPAGATION_MODE: null,
      DD_LOGS_OTEL_ENABLED: false,
      DD_METRICS_OTEL_ENABLED: false,
      DD_TRACE_OTEL_ENABLED: false,
      DD_TRACE_OTEL_SEMANTICS_ENABLED: false,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: false,
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: null,
      OTEL_BSP_MAX_QUEUE_SIZE: null,
      OTEL_BSP_SCHEDULE_DELAY: null,
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_HEADERS: {},
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: {},
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: null,
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: null,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: {},
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: null,
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: null,
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: null,
      OTEL_EXPORTER_OTLP_PROTOCOL: null,
      OTEL_EXPORTER_OTLP_TIMEOUT: null,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: {},
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: null,
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: null,
      OTEL_LOG_LEVEL: null,
      OTEL_LOGS_EXPORTER: null,
      OTEL_METRIC_EXPORT_INTERVAL: null,
      OTEL_METRIC_EXPORT_TIMEOUT: null,
      OTEL_METRICS_EXPORTER: null,
      OTEL_PROPAGATORS: { inject: [], extract: [] },
      OTEL_RESOURCE_ATTRIBUTES: {},
      OTEL_SDK_DISABLED: null,
      OTEL_SERVICE_NAME: 'test',
      OTEL_TRACES_EXPORTER: null,
      OTEL_TRACES_SAMPLER: 'datadog_custom_rules',
      OTEL_TRACES_SAMPLER_ARG: null,
      OTEL_TRACES_SPAN_METRICS_ENABLED: null,
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

describe('otlp export flags', () => {
  function clearOtlpEnv () {
    delete process.env.OTEL_TRACES_EXPORTER
    delete process.env.OTEL_METRICS_EXPORTER
    delete process.env.OTEL_LOGS_EXPORTER
    delete process.env.DD_METRICS_OTEL_ENABLED
    delete process.env.DD_LOGS_OTEL_ENABLED
  }

  // Datadog-instrumented dev shells export the OTEL_*_EXPORTER selectors: a leaked
  // OTEL_TRACES_EXPORTER=otlp corrupts the default-state assertion, and OTEL_METRICS_EXPORTER=none
  // makes config force DD_METRICS_OTEL_ENABLED back to false, breaking the metrics positive case.
  beforeEach(clearOtlpEnv)
  afterEach(clearOtlpEnv)

  function startupLogObj (configOptions) {
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      startupLog,
    } = require('../src/startup-log')
    process.env.DD_TRACE_STARTUP_LOGS = 'true'
    setStartupLogConfig(getConfigFresh(configOptions))
    startupLog()
    /* eslint-disable-next-line no-console */
    const warnStub = /** @type {sinon.SinonStub} */ (console.warn)
    const logObj = JSON.parse(warnStub.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    warnStub.restore()
    return logObj
  }

  it('should default to false when no OTLP env vars are set', () => {
    const logObj = startupLogObj()
    assert.strictEqual(logObj.otlp_traces_export_enabled, false)
    assert.strictEqual(logObj.otlp_metrics_export_enabled, false)
    assert.strictEqual(logObj.otlp_logs_export_enabled, false)
  })

  it('otlp_traces_export_enabled should be true when OTEL_TRACES_EXPORTER is otlp', () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp'
    assert.strictEqual(startupLogObj().otlp_traces_export_enabled, true)
  })

  it('otlp_traces_export_enabled should be false when OTEL_TRACES_EXPORTER is none', () => {
    process.env.OTEL_TRACES_EXPORTER = 'none'
    assert.strictEqual(startupLogObj().otlp_traces_export_enabled, false)
  })

  it('otlp_traces_export_enabled should be false in Test Optimization mode even when exporter is otlp', () => {
    // Test Optimization keeps test spans on the citestcycle endpoint, so the OTLP
    // trace exporter is not used regardless of OTEL_TRACES_EXPORTER (see opentracing/tracer.js).
    process.env.OTEL_TRACES_EXPORTER = 'otlp'
    assert.strictEqual(startupLogObj({ isCiVisibility: true }).otlp_traces_export_enabled, false)
  })

  it('otlp_metrics_export_enabled should be true when DD_METRICS_OTEL_ENABLED is true', () => {
    process.env.DD_METRICS_OTEL_ENABLED = 'true'
    assert.strictEqual(startupLogObj().otlp_metrics_export_enabled, true)
  })

  it('otlp_logs_export_enabled should be true when DD_LOGS_OTEL_ENABLED is true', () => {
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    assert.strictEqual(startupLogObj().otlp_logs_export_enabled, true)
  })
})

describe('resolved OpenTelemetry startup configuration', () => {
  let env
  let warn
  let startupLog

  beforeEach(() => {
    env = process.env
    process.env = { DD_TRACE_STARTUP_LOGS: 'true' }
    warn = sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    startupLog = require('../src/startup-log')
  })

  afterEach(() => {
    warn.restore()
    process.env = env
  })

  /**
   * @param {import('../../../index').TracerOptions} [options]
   */
  function logConfiguration (options) {
    const config = getConfigFresh(options)
    const PrioritySampler = proxyquire('../src/priority_sampler', { './startup-log': startupLog })
    // Construct the runtime sampler to publish its normalized diagnostic rules.
    // eslint-disable-next-line no-new
    new PrioritySampler(config.env, config.sampler)
    startupLog.setStartupLogConfig(config)
    startupLog.startupLog()
    return JSON.parse(warn.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
  }

  it('should include supported OTel settings with resolved defaults and native JSON types', () => {
    const info = logConfiguration({ service: 'startup-test' })
    const otel = Object.fromEntries(Object.entries(info).filter(([name]) => name.startsWith('OTEL_')))
    assert.deepEqual(otel, {
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 512,
      OTEL_BSP_MAX_QUEUE_SIZE: 2048,
      OTEL_BSP_SCHEDULE_DELAY: 5000,
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_HEADERS: {},
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4318/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: {},
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: 10000,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4318/v1/metrics',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: {},
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: 10000,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_TIMEOUT: 10000,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: {},
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: 10000,
      OTEL_LOG_LEVEL: 'debug',
      OTEL_LOGS_EXPORTER: null,
      OTEL_METRIC_EXPORT_INTERVAL: 10000,
      OTEL_METRIC_EXPORT_TIMEOUT: 7500,
      OTEL_METRICS_EXPORTER: null,
      OTEL_PROPAGATORS: {
        inject: ['datadog', 'tracecontext', 'baggage'],
        extract: ['datadog', 'tracecontext', 'baggage'],
      },
      OTEL_RESOURCE_ATTRIBUTES: {},
      OTEL_SDK_DISABLED: true,
      OTEL_SERVICE_NAME: 'startup-test',
      OTEL_TRACES_EXPORTER: null,
      OTEL_TRACES_SAMPLER: null,
      OTEL_TRACES_SAMPLER_ARG: null,
      OTEL_TRACES_SPAN_METRICS_ENABLED: false,
    })
    assertObjectContains(info, {
      DD_AGENT_HOST: '127.0.0.1',
      DD_DATA_STREAMS_ENABLED: false,
      DD_DBM_PROPAGATION_MODE: 'disabled',
      DD_LOGS_OTEL_ENABLED: false,
      DD_METRICS_OTEL_ENABLED: false,
      DD_TRACE_OTEL_ENABLED: false,
      DD_TRACE_OTEL_SEMANTICS_ENABLED: false,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: false,
    })
  })

  it('should log OTel aliases as resolved service, log level, and propagation styles', () => {
    process.env.OTEL_SERVICE_NAME = 'otel-service'
    process.env.OTEL_LOG_LEVEL = 'INFO'
    process.env.OTEL_PROPAGATORS = 'tracecontext,baggage'
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment.name=production,custom=value'

    assertObjectContains(logConfiguration(), {
      OTEL_SERVICE_NAME: 'otel-service',
      OTEL_LOG_LEVEL: 'INFO',
      OTEL_PROPAGATORS: { inject: ['tracecontext', 'baggage'], extract: ['tracecontext', 'baggage'] },
      OTEL_RESOURCE_ATTRIBUTES: { env: 'production', custom: 'value' },
    })
  })

  for (const styles of [
    { inject: ['tracecontext', 'baggage'], extract: ['tracecontext', 'baggage'] },
    { inject: ['tracecontext'], extract: ['datadog', 'tracecontext'] },
    { inject: [], extract: [] },
  ]) {
    it(`should preserve both propagation directions in startup and flare: ${JSON.stringify(styles)}`, () => {
      const config = getConfigFresh({ tracePropagationStyle: styles })
      const before = JSON.stringify(config.tracePropagationStyle)
      startupLog.setStartupLogConfig(config)
      startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
      startupLog.startupLog()
      const info = JSON.parse(warn.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
      const flare = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
      for (const output of [info, flare]) {
        assert.deepEqual(output.OTEL_PROPAGATORS, styles)
        assert.equal(Object.hasOwn(output, 'DD_TRACE_PROPAGATION_STYLE_INJECT'), false)
        assert.equal(Object.hasOwn(output, 'DD_TRACE_PROPAGATION_STYLE_EXTRACT'), false)
      }
      assert.equal(JSON.stringify(config.tracePropagationStyle), before)
    })
  }

  for (const codeOptions of [false, true]) {
    it(`should honor ${codeOptions ? 'code' : 'Datadog environment'} precedence over OTel aliases`, () => {
      process.env.OTEL_SERVICE_NAME = 'otel-service'
      process.env.DD_SERVICE = 'dd-service'
      process.env.OTEL_LOG_LEVEL = 'info'
      process.env.DD_TRACE_LOG_LEVEL = 'error'
      process.env.OTEL_PROPAGATORS = 'b3'
      process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'baggage'
      process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'tracecontext'

      /** @type {import('../../../index').TracerOptions | undefined} */
      const options = codeOptions
        ? { service: 'code-service', logLevel: 'warn', tracePropagationStyle: { inject: ['datadog'], extract: ['b3'] } }
        : undefined
      assertObjectContains(logConfiguration(options), {
        OTEL_SERVICE_NAME: codeOptions ? 'code-service' : 'dd-service',
        OTEL_LOG_LEVEL: codeOptions ? 'warn' : 'error',
        OTEL_PROPAGATORS: codeOptions
          ? { inject: ['datadog'], extract: ['b3'] }
          : { inject: ['baggage'], extract: ['tracecontext'] },
      })
    })
  }

  it('should report generic OTLP fallbacks and signal-specific overrides', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/base/'
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'HTTP/PROTOBUF'
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '1234'
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://logs:4318/custom'
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'HTTP/JSON'
    process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = '2345'

    assertObjectContains(logConfiguration(), {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/base/',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/base/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/base/v1/metrics',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs:4318/custom',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_TIMEOUT: 1234,
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: 1234,
      OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: 1234,
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: 2345,
    })
  })

  it('should log parsed numbers and booleans, including false and zero', () => {
    Object.assign(process.env, {
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '123',
      OTEL_BSP_MAX_QUEUE_SIZE: '456',
      OTEL_BSP_SCHEDULE_DELAY: '789',
      OTEL_METRIC_EXPORT_INTERVAL: '1234',
      OTEL_METRIC_EXPORT_TIMEOUT: '2345',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
      OTEL_SDK_DISABLED: 'false',
      DD_TRACE_OTEL_ENABLED: 'true',
      DD_LOGS_OTEL_ENABLED: 'true',
      DD_METRICS_OTEL_ENABLED: 'true',
      DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
      DD_AGENT_HOST: 'agent',
      DD_DBM_PROPAGATION_MODE: 'full',
      DD_DATA_STREAMS_ENABLED: 'true',
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: 'true',
    })

    assertObjectContains(logConfiguration(), {
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 123,
      OTEL_BSP_MAX_QUEUE_SIZE: 456,
      OTEL_BSP_SCHEDULE_DELAY: 789,
      OTEL_METRIC_EXPORT_INTERVAL: 1234,
      OTEL_METRIC_EXPORT_TIMEOUT: 2345,
      OTEL_TRACES_SAMPLER: 'parentbased_always_off',
      OTEL_TRACES_SAMPLER_ARG: null,
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
      OTEL_TRACES_SPAN_METRICS_ENABLED: true,
      OTEL_SDK_DISABLED: false,
      DD_TRACE_OTEL_ENABLED: true,
      DD_LOGS_OTEL_ENABLED: true,
      DD_METRICS_OTEL_ENABLED: true,
      DD_TRACE_OTEL_SEMANTICS_ENABLED: true,
      DD_AGENT_HOST: 'agent',
      DD_DBM_PROPAGATION_MODE: 'full',
      DD_DATA_STREAMS_ENABLED: true,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: true,
    })
  })

  for (const [input, resolved, expected] of [
    ['DeLtA', 'DELTA', 'delta'],
    ['CuMuLaTiVe', 'CUMULATIVE', 'cumulative'],
    ['LoWmEmOrY', 'LOWMEMORY', 'lowmemory'],
    ['invalid', 'DELTA', 'delta'],
  ]) {
    it(`should log resolved temporality ${input} in lowercase without mutating configuration`, () => {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = input
      const config = getConfigFresh()
      assert.equal(config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, resolved)
      startupLog.setStartupLogConfig(config)
      startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
      startupLog.startupLog()

      const info = JSON.parse(warn.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
      const flareInfo = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
      assert.equal(info.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, expected)
      assert.equal(flareInfo.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, expected)
      assert.equal(config.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, resolved)
    })
  }

  it('should report defaults and calculated values when invalid or conflicting values are ignored', () => {
    Object.assign(process.env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'not a URL',
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '0',
      OTEL_TRACES_SAMPLER_ARG: 'invalid',
      OTEL_TRACES_EXPORTER: 'otlp',
      DD_TRACE_AGENT_PROTOCOL_VERSION: '0.4',
      DD_METRICS_OTEL_ENABLED: 'true',
      OTEL_METRICS_EXPORTER: 'none',
    })

    assertObjectContains(logConfiguration(), {
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 512,
      OTEL_TRACES_SAMPLER_ARG: null,
      OTEL_TRACES_EXPORTER: 'none',
      DD_METRICS_OTEL_ENABLED: false,
      otlp_traces_export_enabled: false,
      otlp_metrics_export_enabled: false,
    })
  })

  it('should redact explicit and inherited OTLP headers without mutating configuration', () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=shared-secret,x-custom=custom-secret'
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'authorization=trace-secret'
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = 'x-logs=logs-secret'
    const config = getConfigFresh()
    const headers = [
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    ]
    const originals = headers.map(name => ({ ...config[name] }))
    for (const name of headers) Object.freeze(config[name])
    startupLog.setStartupLogConfig(config)
    startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
    startupLog.startupLog()

    const info = JSON.parse(warn.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    const flareInfo = JSON.stringify(startupLog.tracerInfo())
    assert.doesNotMatch(warn.firstCall.args[0], /shared-secret|custom-secret|trace-secret|logs-secret/)
    assert.doesNotMatch(flareInfo, /shared-secret|custom-secret|trace-secret|logs-secret/)
    for (let i = 0; i < headers.length; i++) {
      const name = headers[i]
      const expected = Object.fromEntries(Object.keys(originals[i]).map(key => [key, '<redacted>']))
      assert.deepEqual(info[name], expected)
      assert.deepEqual(JSON.parse(flareInfo)[name], expected)
      assert.deepEqual(config[name], originals[i])
    }
  })

  for (const [endpoint, expected] of [
    ['https://collector:4318/path?api_key=secret', 'https://collector:4318/path'],
    ['https://collector:4318/path?api%5Fkey=secret&region=eu', 'https://collector:4318/path'],
    ['https://collector:4318/path?custom_credential=secret&custom_credential=other', 'https://collector:4318/path'],
    ['https://collector:4318/path?secret', 'https://collector:4318/path'],
    ['https://collector:4318/path?', 'https://collector:4318/path'],
    ['https://user:secret@collector:4318/path?token=secret', 'https://REDACTED:REDACTED@collector:4318/path'],
    ['https://user:secret@collector:4318/path', 'https://REDACTED:REDACTED@collector:4318/path'],
    ['https://user@collector:4318/path', 'https://REDACTED@collector:4318/path'],
    ['https://user:@collector:4318/path', 'https://REDACTED@collector:4318/path'],
    ['https://:secret@collector:4318/path', 'https://REDACTED:REDACTED@collector:4318/path'],
    ['https://us%40er:sec%3Aret@collector:4318/path', 'https://REDACTED:REDACTED@collector:4318/path'],
    ['https://user:sec@ret@collector:4318/path', 'https://REDACTED:REDACTED@collector:4318/path'],
    ['https:user:secret@collector:4318/path', 'https://REDACTED:REDACTED@collector:4318/path'],
    ['HTTP://Collector:80/path@part?key=value@part#fragment', 'HTTP://Collector:80/path@part'],
    ['HTTP://Collector:80/path@part#fragment', 'HTTP://Collector:80/path@part#fragment'],
  ]) {
    it(`should safely project OTLP endpoint ${endpoint} without mutating configuration`, () => {
      const endpoints = [
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
        'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      ]
      for (const name of endpoints) process.env[name] = endpoint
      const config = getConfigFresh()
      startupLog.setStartupLogConfig(config)
      startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
      startupLog.startupLog()

      const info = JSON.parse(warn.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
      const flareInfo = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
      for (const name of endpoints) {
        assert.equal(info[name], expected)
        assert.equal(flareInfo[name], expected)
        assert.equal(config[name], endpoint)
      }
    })
  }

  it('should redact credentials inherited from the generic OTLP endpoint', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://user:secret@collector:4318/base/'
    const info = logConfiguration()

    assert.equal(info.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://REDACTED:REDACTED@collector:4318/base/')
    for (const signal of ['TRACES', 'LOGS', 'METRICS']) {
      assert.equal(info[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`],
        `https://REDACTED:REDACTED@collector:4318/base/v1/${signal.toLowerCase()}`)
    }
  })

  it('should remove inherited endpoint queries even when span query obfuscation is disabled', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector:4318/base?custom_credential=secret'
    process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = ''
    const config = getConfigFresh()
    assert.equal(config.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP, '')
    startupLog.setStartupLogConfig(config)
    startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
    startupLog.startupLog()

    const info = JSON.parse(warn.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    const flareInfo = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
    for (const suffix of ['', '_TRACES', '_LOGS', '_METRICS']) {
      const name = `OTEL_EXPORTER_OTLP${suffix}_ENDPOINT`
      assert.equal(info[name], 'https://collector:4318/base')
      assert.equal(flareInfo[name], 'https://collector:4318/base')
      assert.match(config[name], /\?custom_credential=secret/)
    }
  })

  it('should preserve calculated OTLP endpoints without credentials', () => {
    process.env.DD_AGENT_HOST = '::1'
    const info = logConfiguration()

    for (const signal of ['TRACES', 'LOGS', 'METRICS']) {
      assert.equal(info[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`], `http://::1:4318/v1/${signal.toLowerCase()}`)
    }
  })

  it('should omit unparseable OTLP endpoints that may contain credentials', () => {
    process.env.DD_TRACE_AGENT_URL = 'http://127.0.0.1:8126'
    process.env.DD_AGENT_HOST = 'collector@::1'
    const info = logConfiguration()

    for (const signal of ['TRACES', 'LOGS', 'METRICS']) {
      assert.equal(info[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`], null)
    }
  })

  it('should redact agentless API keys injected into all signal-specific headers', () => {
    process.env.DD_AGENTLESS_ENABLED = 'true'
    process.env.DD_API_KEY = 'injected-api-key-secret'
    const info = logConfiguration()

    assert.doesNotMatch(warn.firstCall.args[0], /injected-api-key-secret/)
    assert.deepEqual(info.OTEL_EXPORTER_OTLP_HEADERS, {})
    for (const signal of ['TRACES', 'LOGS', 'METRICS']) {
      assert.deepEqual(info[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`], { 'dd-api-key': '<redacted>' })
    }
  })

  it('should preserve header names that shadow object properties', () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      'constructor=constructor-secret,toString=string-secret,toJSON=json-secret'
    const info = logConfiguration()

    assert.deepEqual(info.OTEL_EXPORTER_OTLP_HEADERS, {
      constructor: '<redacted>', toString: '<redacted>', toJSON: '<redacted>',
    })
    assert.doesNotMatch(warn.firstCall.args[0], /constructor-secret|string-secret|json-secret/)
  })
})
