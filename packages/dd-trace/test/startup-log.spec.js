'use strict'

const os = require('os')
const tracerVersion = require('../lib/version')

describe('startup logging', () => {
  let semverVersion
  let firstStderrCall
  let secondStderrCall
  before(() => {
    sinon.stub(console, 'info')
    sinon.stub(console, 'warn')
    semverVersion = require('semver/package.json').version
    delete require.cache[require.resolve('../src/startup-log')]
    const {
      setStartupLogConfig,
      setStartupLogInstrumenter,
      setSamplingRules,
      startupLog
    } = require('../src/startup-log')
    setStartupLogInstrumenter({
      _instrumented: {
        keys () {
          return [{ name: 'http' }, { name: 'fs' }, { name: 'semver', versions: [] }]
        }
      },
      _plugins: new Map([
        ['fs', { config: { analytics: 0.5 } }],
        ['http', { config: { analytics: true } }],
        ['semver', { config: { analytics: { a: 0.7 } } }]
      ])
    })
    setStartupLogConfig({
      env: 'production',
      enabled: true,
      scope: 'async_hooks',
      service: 'test',
      hostname: 'example.com',
      port: 4321,
      debug: true,
      analytics: true,
      sampleRate: 1,
      tags: { version: '1.2.3' },
      logInjection: true,
      runtimeMetrics: true,
      startupLogs: true
    })
    setSamplingRules(['rule1', 'rule2'])
    startupLog({ agentError: { message: 'Error: fake error' } })
    firstStderrCall = console.info.firstCall /* eslint-disable-line no-console */
    secondStderrCall = console.warn.firstCall /* eslint-disable-line no-console */
    console.info.restore() /* eslint-disable-line no-console */
    console.warn.restore() /* eslint-disable-line no-console */
  })

  it('startupLog should be formatted correctly', () => {
    expect(firstStderrCall.args[0].startsWith('DATADOG TRACER CONFIGURATION - ')).to.equal(true)
    const logObj = JSON.parse(firstStderrCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    expect(typeof logObj).to.equal('object')
    expect(typeof logObj.date).to.equal('string')
    expect(logObj.date.length).to.equal(new Date().toISOString().length)
    expect(logObj.tags).to.deep.equal({ version: '1.2.3' })
    expect(logObj.sampling_rules).to.deep.equal(['rule1', 'rule2'])
    expect(logObj).to.deep.include({
      os_name: os.type(),
      os_version: os.release(),
      version: tracerVersion,
      lang: 'nodejs',
      lang_version: process.versions.node,
      env: 'production',
      enabled: true,
      scope_manager: 'async_hooks',
      service: 'test',
      agent_url: 'http://example.com:4321',
      agent_error: 'Error: fake error',
      debug: true,
      analytics_enabled: true,
      sample_rate: 1,
      dd_version: '1.2.3',
      log_injection_enabled: true,
      runtime_metrics_enabled: true,
      integration_http_analytics_enabled: true,
      integration_fs_analytics_enabled: true,
      integration_fs_sample_rate: 0.5,
      integration_semver_analytics_enabled: true,
      integration_semver_sample_rate: { a: 0.7 }
    })
    expect(logObj.integration_semver_sample_rate).to.deep.equal({ a: 0.7 })
  })

  it('startupLog should correctly also output the diagnostic message', () => {
    expect(secondStderrCall.args[0]).to.equal('DATADOG TRACER DIAGNOSTIC - Agent Error: Error: fake error')
  })

  it('setStartupLogPlugins should add plugins to integrations_loaded', () => {
    const logObj = JSON.parse(firstStderrCall.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    const integrationsLoaded = logObj.integrations_loaded
    expect(integrationsLoaded).to.include('fs')
    expect(integrationsLoaded).to.include('http')
    expect(integrationsLoaded).to.include('semver@' + semverVersion)
  })
})
