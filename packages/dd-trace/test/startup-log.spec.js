'use strict'

const { expect } = require('chai')
const { describe, it, before } = require('tap').mocha
const sinon = require('sinon')
const assert = require('node:assert')
const os = require('node:os')

require('./setup/tap')

const Config = require('../src/config')
const SamplingRule = require('../src/sampling_rule')
const tracerVersion = require('../../../package.json').version

describe('startup logging', () => {
  let firstStderrCall
  let secondStderrCall
  let tracerInfoMethod

  before(() => {
    sinon.stub(console, 'info')
    sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogPluginManager,
      setSamplingRules,
      startupLog,
      tracerInfo
    } = require('../src/startup-log')
    tracerInfoMethod = tracerInfo
    setStartupLogPluginManager({
      _pluginsByName: {
        http: { _enabled: true },
        fs: { _enabled: true },
        semver: { _enabled: true }
      }
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
        sampleRate: 1
      },
      tags: { version: '1.2.3', invalid_but_listed_due_to_mocking: 42n },
      logInjection: true,
      runtimeMetrics: true,
      startupLogs: true,
      appsec: { enabled: true }
    })
    setSamplingRules([
      new SamplingRule({ name: 'rule1', sampleRate: 0.4 }),
      'rule2',
      new SamplingRule({ name: 'rule3', sampleRate: 1.4 })
    ])
    startupLog({ agentError: { message: 'Error: fake error' } })
    firstStderrCall = console.info.firstCall /* eslint-disable-line no-console */
    secondStderrCall = console.warn.firstCall /* eslint-disable-line no-console */
    console.info.restore() /* eslint-disable-line no-console */
    console.warn.restore() /* eslint-disable-line no-console */
  })

  it('startupLog should be formatted correctly', () => {
    expect(firstStderrCall.args[0].startsWith('DATADOG TRACER CONFIGURATION - ')).to.equal(true)
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
      agent_url: 'http://example.com:4321',
      debug: true,
      sample_rate: 1,
      sampling_rules: [
        { matchers: [{ pattern: 'rule1' }], _sampler: { _rate: 0.4 } },
        'rule2',
        { matchers: [{ pattern: 'rule3' }], _sampler: { _rate: 1 } }
      ],
      tags: { version: '1.2.3', invalid_but_listed_due_to_mocking: '42' },
      dd_version: '1.2.3',
      log_injection_enabled: true,
      runtime_metrics_enabled: true,
      profiling_enabled: false,
      integrations_loaded: ['http', 'fs', 'semver'],
      appsec_enabled: true
    })
  })

  it('startupLog should correctly also output the diagnostic message', () => {
    expect(secondStderrCall.args[0]).to.equal('DATADOG TRACER DIAGNOSTIC - Agent Error: Error: fake error')
  })
})

describe('profiling_enabled', () => {
  it('should be correctly logged', () => {
    [
      ['undefined', false],
      ['false', false],
      ['FileNotFound', false],
      ['auto', true],
      ['true', true]
    ].forEach(([envVar, expected]) => {
      sinon.stub(console, 'info')
      delete require.cache[require.resolve('../src/startup-log')]
      const {
        setStartupLogConfig,
        setStartupLogPluginManager,
        startupLog
      } = require('../src/startup-log')
      process.env.DD_PROFILING_ENABLED = envVar
      process.env.DD_TRACE_STARTUP_LOGS = 'true'
      setStartupLogConfig(new Config())
      setStartupLogPluginManager({ _pluginsByName: {} })
      startupLog()
      /* eslint-disable-next-line no-console */
      const logObj = JSON.parse(console.info.firstCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
      console.info.restore() /* eslint-disable-line no-console */
      expect(logObj.profiling_enabled).to.equal(expected)
    })
  })
})
