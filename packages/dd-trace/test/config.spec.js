'use strict'

require('./setup/tap')

const { expect } = require('chai')
const { readFileSync } = require('fs')
const sinon = require('sinon')

describe('Config', () => {
  let Config
  let log
  let pkg
  let env
  let fs
  let os
  let existsSyncParam
  let existsSyncReturn
  let osType
  let updateConfig

  const RECOMMENDED_JSON_PATH = require.resolve('../src/appsec/recommended.json')
  const RULES_JSON_PATH = require.resolve('./fixtures/config/appsec-rules.json')
  const BLOCKED_TEMPLATE_HTML_PATH = require.resolve('./fixtures/config/appsec-blocked-template.html')
  const BLOCKED_TEMPLATE_HTML = readFileSync(BLOCKED_TEMPLATE_HTML_PATH, { encoding: 'utf8' })
  const BLOCKED_TEMPLATE_JSON_PATH = require.resolve('./fixtures/config/appsec-blocked-template.json')
  const BLOCKED_TEMPLATE_JSON = readFileSync(BLOCKED_TEMPLATE_JSON_PATH, { encoding: 'utf8' })
  const BLOCKED_TEMPLATE_GRAPHQL_PATH = require.resolve('./fixtures/config/appsec-blocked-graphql-template.json')
  const BLOCKED_TEMPLATE_GRAPHQL = readFileSync(BLOCKED_TEMPLATE_GRAPHQL_PATH, { encoding: 'utf8' })
  const DD_GIT_PROPERTIES_FILE = require.resolve('./fixtures/config/git.properties')

  beforeEach(() => {
    pkg = {
      name: '',
      version: ''
    }

    log = {
      use: sinon.spy(),
      toggle: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy()
    }

    updateConfig = sinon.stub()

    env = process.env
    process.env = {}
    fs = {
      existsSync: (param) => {
        existsSyncParam = param
        return existsSyncReturn
      }
    }
    os = {
      type () {
        return osType
      }
    }
    osType = 'Linux'

    Config = proxyquire('../src/config', {
      './pkg': pkg,
      './log': log,
      './telemetry': { updateConfig },
      fs,
      os
    })
  })

  afterEach(() => {
    updateConfig.reset()
    process.env = env
    existsSyncParam = undefined
  })

  it('should initialize from environment variables with DD env vars taking precedence OTEL env vars', () => {
    process.env.DD_SERVICE = 'service'
    process.env.OTEL_SERVICE_NAME = 'otel_service'
    process.env.DD_TRACE_LOG_LEVEL = 'error'
    process.env.OTEL_LOG_LEVEL = 'debug'
    process.env.DD_TRACE_SAMPLE_RATE = '0.5'
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.1'
    process.env.DD_TRACE_ENABLED = 'true'
    process.env.OTEL_TRACES_EXPORTER = 'none'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.OTEL_METRICS_EXPORTER = 'none'
    process.env.DD_TAGS = 'foo:bar,baz:qux'
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'foo=bar1,baz=qux1'
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'b3,tracecontext'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'b3,tracecontext'
    process.env.OTEL_PROPAGATORS = 'datadog,tracecontext'

    const config = new Config()

    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('logLevel', 'error')
    expect(config).to.have.property('sampleRate', 0.5)
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config.tags).to.include({ foo: 'bar', baz: 'qux' })
    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', ['b3', 'tracecontext'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', ['b3', 'tracecontext'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.otelPropagators', false)

    const indexFile = require('../src/index')
    const proxy = require('../src/proxy')
    expect(indexFile).to.equal(proxy)
  })

  it('should initialize with OTEL environment variables when DD env vars are not set', () => {
    process.env.OTEL_SERVICE_NAME = 'otel_service'
    process.env.OTEL_LOG_LEVEL = 'warn'
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.1'
    process.env.OTEL_TRACES_EXPORTER = 'none'
    process.env.OTEL_METRICS_EXPORTER = 'none'
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'foo=bar1,baz=qux1'
    process.env.OTEL_PROPAGATORS = 'b3,datadog'

    const config = new Config()

    expect(config).to.have.property('service', 'otel_service')
    expect(config).to.have.property('logLevel', 'warn')
    expect(config).to.have.property('sampleRate', 0.1)
    expect(config).to.have.property('runtimeMetrics', false)
    expect(config.tags).to.include({ foo: 'bar1', baz: 'qux1' })
    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', ['b3', 'datadog'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', ['b3', 'datadog'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.otelPropagators', true)

    delete require.cache[require.resolve('../src/index')]
    const indexFile = require('../src/index')
    const noop = require('../src/noop/proxy')
    expect(indexFile).to.equal(noop)
  })

  it('should correctly map OTEL_RESOURCE_ATTRIBUTES', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
    'deployment.environment=test1,service.name=test2,service.version=5,foo=bar1,baz=qux1'
    const config = new Config()

    expect(config).to.have.property('env', 'test1')
    expect(config).to.have.property('service', 'test2')
    expect(config).to.have.property('version', '5')
    expect(config.tags).to.include({ foo: 'bar1', baz: 'qux1' })
  })

  it('should correctly map OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_on'
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.1'
    let config = new Config()
    expect(config).to.have.property('sampleRate', 1.0)

    process.env.OTEL_TRACES_SAMPLER = 'always_off'
    config = new Config()
    expect(config).to.have.property('sampleRate', 0.0)

    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    config = new Config()
    expect(config).to.have.property('sampleRate', 0.1)

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_on'
    config = new Config()
    expect(config).to.have.property('sampleRate', 1.0)

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_off'
    config = new Config()
    expect(config).to.have.property('sampleRate', 0.0)

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_traceidratio'
    config = new Config()
    expect(config).to.have.property('sampleRate', 0.1)
  })

  it('should initialize with the correct defaults', () => {
    const config = new Config()

    expect(config).to.have.property('service', 'node')
    expect(config).to.have.property('tracing', true)
    expect(config).to.have.property('debug', false)
    expect(config).to.have.property('protocolVersion', '0.4')
    expect(config).to.have.nested.property('dogstatsd.hostname', '127.0.0.1')
    expect(config).to.have.nested.property('dogstatsd.port', '8125')
    expect(config).to.have.property('flushInterval', 2000)
    expect(config).to.have.property('flushMinSpans', 1000)
    expect(config).to.have.property('queryStringObfuscation').with.length(626)
    expect(config).to.have.property('clientIpEnabled', false)
    expect(config).to.have.property('clientIpHeader', null)
    expect(config).to.have.property('sampleRate', undefined)
    expect(config).to.have.property('runtimeMetrics', false)
    expect(config.tags).to.have.property('service', 'node')
    expect(config).to.have.property('plugins', true)
    expect(config).to.have.property('env', undefined)
    expect(config).to.have.property('reportHostname', false)
    expect(config).to.have.property('scope', undefined)
    expect(config).to.have.property('logLevel', 'debug')
    expect(config).to.have.property('traceId128BitGenerationEnabled', true)
    expect(config).to.have.property('traceId128BitLoggingEnabled', false)
    expect(config).to.have.property('spanAttributeSchema', 'v0')
    expect(config).to.have.property('spanComputePeerService', false)
    expect(config).to.have.property('spanRemoveIntegrationFromService', false)
    expect(config).to.have.deep.property('serviceMapping', {})
    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', ['datadog', 'tracecontext'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', ['datadog', 'tracecontext'])
    expect(config).to.have.nested.property('experimental.runtimeId', false)
    expect(config).to.have.nested.property('experimental.exporter', undefined)
    expect(config).to.have.nested.property('experimental.enableGetRumData', false)
    expect(config).to.have.nested.property('appsec.enabled', undefined)
    expect(config).to.have.nested.property('appsec.rules', undefined)
    expect(config).to.have.nested.property('appsec.rateLimit', 100)
    expect(config).to.have.nested.property('appsec.wafTimeout', 5e3)
    expect(config).to.have.nested.property('appsec.obfuscatorKeyRegex').with.length(155)
    expect(config).to.have.nested.property('appsec.obfuscatorValueRegex').with.length(443)
    expect(config).to.have.nested.property('appsec.blockedTemplateHtml', undefined)
    expect(config).to.have.nested.property('appsec.blockedTemplateJson', undefined)
    expect(config).to.have.nested.property('appsec.blockedTemplateGraphql', undefined)
    expect(config).to.have.nested.property('appsec.eventTracking.enabled', true)
    expect(config).to.have.nested.property('appsec.eventTracking.mode', 'safe')
    expect(config).to.have.nested.property('appsec.apiSecurity.enabled', true)
    expect(config).to.have.nested.property('appsec.apiSecurity.requestSampling', 0.1)
    expect(config).to.have.nested.property('appsec.sca.enabled', null)
    expect(config).to.have.nested.property('remoteConfig.enabled', true)
    expect(config).to.have.nested.property('remoteConfig.pollInterval', 5)
    expect(config).to.have.nested.property('iast.enabled', false)
    expect(config).to.have.nested.property('iast.redactionEnabled', true)
    expect(config).to.have.nested.property('iast.redactionNamePattern', null)
    expect(config).to.have.nested.property('iast.redactionValuePattern', null)
    expect(config).to.have.nested.property('iast.telemetryVerbosity', 'INFORMATION')
    expect(config).to.have.nested.property('installSignature.id', null)
    expect(config).to.have.nested.property('installSignature.time', null)
    expect(config).to.have.nested.property('installSignature.type', null)

    expect(updateConfig).to.be.calledOnce

    expect(updateConfig.getCall(0).args[0]).to.deep.include.members([
      { name: 'appsec.blockedTemplateHtml', value: undefined, origin: 'default' },
      { name: 'appsec.blockedTemplateJson', value: undefined, origin: 'default' },
      { name: 'appsec.enabled', value: undefined, origin: 'default' },
      {
        name: 'appsec.obfuscatorKeyRegex',
        // eslint-disable-next-line max-len
        value: '(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?)key)|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization',
        origin: 'default'
      },
      {
        name: 'appsec.obfuscatorValueRegex',
        // eslint-disable-next-line max-len
        value: '(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}',
        origin: 'default'
      },
      { name: 'appsec.rateLimit', value: 100, origin: 'default' },
      { name: 'appsec.rules', value: undefined, origin: 'default' },
      { name: 'appsec.sca.enabled', value: null, origin: 'default' },
      { name: 'appsec.wafTimeout', value: 5e3, origin: 'default' },
      { name: 'clientIpEnabled', value: false, origin: 'default' },
      { name: 'clientIpHeader', value: null, origin: 'default' },
      { name: 'dbmPropagationMode', value: 'disabled', origin: 'default' },
      { name: 'dogstatsd.hostname', value: '127.0.0.1', origin: 'calculated' },
      { name: 'dogstatsd.port', value: '8125', origin: 'default' },
      { name: 'dsmEnabled', value: false, origin: 'default' },
      { name: 'env', value: undefined, origin: 'default' },
      { name: 'experimental.enableGetRumData', value: false, origin: 'default' },
      { name: 'experimental.exporter', value: undefined, origin: 'default' },
      { name: 'experimental.runtimeId', value: false, origin: 'default' },
      { name: 'flushInterval', value: 2000, origin: 'default' },
      { name: 'flushMinSpans', value: 1000, origin: 'default' },
      { name: 'gitMetadataEnabled', value: true, origin: 'default' },
      { name: 'headerTags', value: [], origin: 'default' },
      { name: 'hostname', value: '127.0.0.1', origin: 'default' },
      { name: 'iast.deduplicationEnabled', value: true, origin: 'default' },
      { name: 'iast.enabled', value: false, origin: 'default' },
      { name: 'iast.maxConcurrentRequests', value: 2, origin: 'default' },
      { name: 'iast.maxContextOperations', value: 2, origin: 'default' },
      { name: 'iast.redactionEnabled', value: true, origin: 'default' },
      { name: 'iast.redactionNamePattern', value: null, origin: 'default' },
      { name: 'iast.redactionValuePattern', value: null, origin: 'default' },
      { name: 'iast.requestSampling', value: 30, origin: 'default' },
      { name: 'iast.telemetryVerbosity', value: 'INFORMATION', origin: 'default' },
      { name: 'isCiVisibility', value: false, origin: 'default' },
      { name: 'isEarlyFlakeDetectionEnabled', value: false, origin: 'default' },
      { name: 'isGCPFunction', value: false, origin: 'env_var' },
      { name: 'isGitUploadEnabled', value: false, origin: 'default' },
      { name: 'isIntelligentTestRunnerEnabled', value: false, origin: 'default' },
      { name: 'isManualApiEnabled', value: false, origin: 'default' },
      { name: 'logInjection', value: false, origin: 'default' },
      { name: 'lookup', value: undefined, origin: 'default' },
      { name: 'openAiLogsEnabled', value: false, origin: 'default' },
      { name: 'openaiSpanCharLimit', value: 128, origin: 'default' },
      { name: 'peerServiceMapping', value: {}, origin: 'default' },
      { name: 'plugins', value: true, origin: 'default' },
      { name: 'port', value: '8126', origin: 'default' },
      { name: 'profiling.enabled', value: false, origin: 'default' },
      { name: 'profiling.exporters', value: 'agent', origin: 'default' },
      { name: 'profiling.sourceMap', value: true, origin: 'default' },
      { name: 'protocolVersion', value: '0.4', origin: 'default' },
      {
        name: 'queryStringObfuscation',
        // eslint-disable-next-line max-len
        value: '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\\s|%20)*(?::|%3A)(?:\\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\\w=-]|%3D)+\\.ey[I-L](?:[\\w=-]|%3D)+(?:\\.(?:[\\w.+\\/=-]|%3D|%2F|%2B)+)?|[\\-]{5}BEGIN(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY[\\-]{5}[^\\-]+[\\-]{5}END(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY|ssh-rsa(?:\\s|%20)*(?:[a-z0-9\\/\\.+]|%2F|%5C|%2B){100,}',
        origin: 'default'
      },
      { name: 'remoteConfig.enabled', value: true, origin: 'env_var' },
      { name: 'remoteConfig.pollInterval', value: 5, origin: 'default' },
      { name: 'reportHostname', value: false, origin: 'default' },
      { name: 'reportHostname', value: false, origin: 'default' },
      { name: 'runtimeMetrics', value: false, origin: 'default' },
      { name: 'sampleRate', value: undefined, origin: 'default' },
      { name: 'sampler.rateLimit', value: undefined, origin: 'default' },
      { name: 'scope', value: undefined, origin: 'default' },
      { name: 'service', value: 'node', origin: 'default' },
      { name: 'site', value: 'datadoghq.com', origin: 'default' },
      { name: 'spanAttributeSchema', value: 'v0', origin: 'default' },
      { name: 'spanComputePeerService', value: false, origin: 'calculated' },
      { name: 'spanRemoveIntegrationFromService', value: false, origin: 'default' },
      { name: 'startupLogs', value: false, origin: 'default' },
      { name: 'stats.enabled', value: false, origin: 'calculated' },
      { name: 'tagsHeaderMaxLength', value: 512, origin: 'default' },
      { name: 'telemetry.debug', value: false, origin: 'default' },
      { name: 'telemetry.dependencyCollection', value: true, origin: 'default' },
      { name: 'telemetry.enabled', value: true, origin: 'env_var' },
      { name: 'telemetry.heartbeatInterval', value: 60000, origin: 'default' },
      { name: 'telemetry.logCollection', value: false, origin: 'default' },
      { name: 'telemetry.metrics', value: true, origin: 'default' },
      { name: 'traceId128BitGenerationEnabled', value: true, origin: 'default' },
      { name: 'traceId128BitLoggingEnabled', value: false, origin: 'default' },
      { name: 'tracing', value: true, origin: 'default' },
      { name: 'url', value: undefined, origin: 'default' },
      { name: 'version', value: '', origin: 'default' }
    ])
  })

  it('should support logging', () => {
    const config = new Config({
      logger: {},
      debug: true
    })

    expect(log.use).to.have.been.calledWith(config.logger)
    expect(log.toggle).to.have.been.calledWith(config.debug)
  })

  it('should not warn on undefined DD_TRACE_SPAN_ATTRIBUTE_SCHEMA', () => {
    const config = new Config({
      logger: {},
      debug: true
    })
    expect(log.warn).not.to.be.called
    expect(config).to.have.property('spanAttributeSchema', 'v0')
  })

  it('should initialize from the default service', () => {
    pkg.name = 'test'

    const config = new Config()

    expect(config).to.have.property('service', 'test')
    expect(config.tags).to.have.property('service', 'test')
  })

  it('should initialize from the default version', () => {
    pkg.version = '1.2.3'

    const config = new Config()

    expect(config).to.have.property('version', '1.2.3')
    expect(config.tags).to.have.property('version', '1.2.3')
  })

  it('should initialize from environment variables', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_DOGSTATSD_HOSTNAME = 'dsd-agent'
    process.env.DD_DOGSTATSD_PORT = '5218'
    process.env.DD_TRACING_ENABLED = 'false'
    process.env.DD_TRACE_DEBUG = 'true'
    process.env.DD_TRACE_AGENT_PROTOCOL_VERSION = '0.5'
    process.env.DD_SERVICE = 'service'
    process.env.DD_SERVICE_MAPPING = 'a:aa, b:bb'
    process.env.DD_TRACE_PEER_SERVICE_MAPPING = 'c:cc, d:dd'
    process.env.DD_VERSION = '1.0.0'
    process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = '.*'
    process.env.DD_TRACE_CLIENT_IP_ENABLED = 'true'
    process.env.DD_TRACE_CLIENT_IP_HEADER = 'x-true-client-ip'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
    process.env.DD_ENV = 'test'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:bar,baz:qux'
    process.env.DD_TRACE_SAMPLE_RATE = '0.5'
    process.env.DD_TRACE_RATE_LIMIT = '-1'
    process.env.DD_TRACE_SAMPLING_RULES = `[
      {"service":"usersvc","name":"healthcheck","sample_rate":0.0 },
      {"service":"usersvc","sample_rate":0.5},
      {"service":"authsvc","sample_rate":1.0},
      {"sample_rate":0.1}
    ]`
    process.env.DD_SPAN_SAMPLING_RULES = `[
      {"service":"mysql","name":"mysql.query","sample_rate":0.0,"max_per_second":1},
      {"service":"mysql","sample_rate":0.5},
      {"service":"mysql","sample_rate":1.0},
      {"sample_rate":0.1}
    ]`
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'b3,tracecontext'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'b3,tracecontext'
    process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'log'
    process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_INTERNAL_ERRORS_ENABLED = 'true'
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v1'
    process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'true'
    process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = 'true'
    process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = true
    process.env.DD_APPSEC_ENABLED = 'true'
    process.env.DD_APPSEC_RULES = RULES_JSON_PATH
    process.env.DD_APPSEC_TRACE_RATE_LIMIT = '42'
    process.env.DD_APPSEC_WAF_TIMEOUT = '42'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = '.*'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = '.*'
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = BLOCKED_TEMPLATE_HTML_PATH
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_JSON_PATH
    process.env.DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_GRAPHQL_PATH
    process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = 'extended'
    process.env.DD_APPSEC_SCA_ENABLED = true
    process.env.DD_REMOTE_CONFIGURATION_ENABLED = 'false'
    process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = '42'
    process.env.DD_IAST_ENABLED = 'true'
    process.env.DD_IAST_REQUEST_SAMPLING = '40'
    process.env.DD_IAST_MAX_CONCURRENT_REQUESTS = '3'
    process.env.DD_IAST_MAX_CONTEXT_OPERATIONS = '4'
    process.env.DD_IAST_DEDUPLICATION_ENABLED = false
    process.env.DD_IAST_REDACTION_ENABLED = false
    process.env.DD_IAST_REDACTION_NAME_PATTERN = 'REDACTION_NAME_PATTERN'
    process.env.DD_IAST_REDACTION_VALUE_PATTERN = 'REDACTION_VALUE_PATTERN'
    process.env.DD_IAST_TELEMETRY_VERBOSITY = 'DEBUG'
    process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = 'true'
    process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = 'true'
    process.env.DD_EXPERIMENTAL_PROFILING_ENABLED = 'true'
    process.env.DD_API_SECURITY_ENABLED = 'true'
    process.env.DD_API_SECURITY_REQUEST_SAMPLE_RATE = 1
    process.env.DD_INSTRUMENTATION_INSTALL_ID = '68e75c48-57ca-4a12-adfc-575c4b05fcbe'
    process.env.DD_INSTRUMENTATION_INSTALL_TYPE = 'k8s_single_step'
    process.env.DD_INSTRUMENTATION_INSTALL_TIME = '1703188212'

    const config = new Config()

    expect(config).to.have.property('tracing', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.property('protocolVersion', '0.5')
    expect(config).to.have.property('hostname', 'agent')
    expect(config).to.have.nested.property('dogstatsd.hostname', 'dsd-agent')
    expect(config).to.have.nested.property('dogstatsd.port', '5218')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('version', '1.0.0')
    expect(config).to.have.property('queryStringObfuscation', '.*')
    expect(config).to.have.property('clientIpEnabled', true)
    expect(config).to.have.property('clientIpHeader', 'x-true-client-ip')
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config).to.have.property('reportHostname', true)
    expect(config).to.have.property('env', 'test')
    expect(config).to.have.property('sampleRate', 0.5)
    expect(config).to.have.property('traceId128BitGenerationEnabled', true)
    expect(config).to.have.property('traceId128BitLoggingEnabled', true)
    expect(config).to.have.property('spanAttributeSchema', 'v1')
    expect(config).to.have.property('spanRemoveIntegrationFromService', true)
    expect(config).to.have.property('spanComputePeerService', true)
    expect(config.tags).to.include({ foo: 'bar', baz: 'qux' })
    expect(config.tags).to.include({ service: 'service', version: '1.0.0', env: 'test' })
    expect(config).to.have.deep.nested.property('sampler', {
      sampleRate: 0.5,
      rateLimit: '-1',
      rules: [
        { service: 'usersvc', name: 'healthcheck', sampleRate: 0.0 },
        { service: 'usersvc', sampleRate: 0.5 },
        { service: 'authsvc', sampleRate: 1.0 },
        { sampleRate: 0.1 }
      ],
      spanSamplingRules: [
        { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
        { service: 'mysql', sampleRate: 0.5 },
        { service: 'mysql', sampleRate: 1.0 },
        { sampleRate: 0.1 }
      ]
    })
    expect(config).to.have.deep.property('serviceMapping', {
      a: 'aa',
      b: 'bb'
    })
    expect(config).to.have.deep.property('peerServiceMapping', {
      c: 'cc',
      d: 'dd'
    })
    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', ['b3', 'tracecontext'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', ['b3', 'tracecontext'])
    expect(config).to.have.nested.property('experimental.runtimeId', true)
    expect(config).to.have.nested.property('experimental.exporter', 'log')
    expect(config).to.have.nested.property('experimental.enableGetRumData', true)
    expect(config).to.have.nested.property('appsec.enabled', true)
    expect(config).to.have.nested.property('appsec.rules', RULES_JSON_PATH)
    expect(config).to.have.nested.property('appsec.rateLimit', 42)
    expect(config).to.have.nested.property('appsec.wafTimeout', 42)
    expect(config).to.have.nested.property('appsec.obfuscatorKeyRegex', '.*')
    expect(config).to.have.nested.property('appsec.obfuscatorValueRegex', '.*')
    expect(config).to.have.nested.property('appsec.blockedTemplateHtml', BLOCKED_TEMPLATE_HTML)
    expect(config).to.have.nested.property('appsec.blockedTemplateJson', BLOCKED_TEMPLATE_JSON)
    expect(config).to.have.nested.property('appsec.blockedTemplateGraphql', BLOCKED_TEMPLATE_GRAPHQL)
    expect(config).to.have.nested.property('appsec.eventTracking.enabled', true)
    expect(config).to.have.nested.property('appsec.eventTracking.mode', 'extended')
    expect(config).to.have.nested.property('appsec.apiSecurity.enabled', true)
    expect(config).to.have.nested.property('appsec.apiSecurity.requestSampling', 1)
    expect(config).to.have.nested.property('appsec.sca.enabled', true)
    expect(config).to.have.nested.property('remoteConfig.enabled', false)
    expect(config).to.have.nested.property('remoteConfig.pollInterval', 42)
    expect(config).to.have.nested.property('iast.enabled', true)
    expect(config).to.have.nested.property('iast.requestSampling', 40)
    expect(config).to.have.nested.property('iast.maxConcurrentRequests', 3)
    expect(config).to.have.nested.property('iast.maxContextOperations', 4)
    expect(config).to.have.nested.property('iast.deduplicationEnabled', false)
    expect(config).to.have.nested.property('iast.redactionEnabled', false)
    expect(config).to.have.nested.property('iast.redactionNamePattern', 'REDACTION_NAME_PATTERN')
    expect(config).to.have.nested.property('iast.redactionValuePattern', 'REDACTION_VALUE_PATTERN')
    expect(config).to.have.nested.property('iast.telemetryVerbosity', 'DEBUG')
    expect(config).to.have.deep.property('installSignature', {
      id: '68e75c48-57ca-4a12-adfc-575c4b05fcbe',
      type: 'k8s_single_step',
      time: '1703188212'
    })

    expect(updateConfig).to.be.calledOnce

    expect(updateConfig.getCall(0).args[0]).to.deep.include.members([
      { name: 'appsec.blockedTemplateHtml', value: BLOCKED_TEMPLATE_HTML, origin: 'env_var' },
      { name: 'appsec.blockedTemplateJson', value: BLOCKED_TEMPLATE_JSON, origin: 'env_var' },
      { name: 'appsec.enabled', value: true, origin: 'env_var' },
      { name: 'appsec.obfuscatorKeyRegex', value: '.*', origin: 'env_var' },
      { name: 'appsec.obfuscatorValueRegex', value: '.*', origin: 'env_var' },
      { name: 'appsec.rateLimit', value: 42, origin: 'env_var' },
      { name: 'appsec.rules', value: RULES_JSON_PATH, origin: 'env_var' },
      { name: 'appsec.sca.enabled', value: true, origin: 'env_var' },
      { name: 'appsec.wafTimeout', value: 42, origin: 'env_var' },
      { name: 'clientIpEnabled', value: true, origin: 'env_var' },
      { name: 'clientIpHeader', value: 'x-true-client-ip', origin: 'env_var' },
      { name: 'dogstatsd.hostname', value: 'dsd-agent', origin: 'env_var' },
      { name: 'dogstatsd.port', value: '5218', origin: 'env_var' },
      { name: 'env', value: 'test', origin: 'env_var' },
      { name: 'experimental.enableGetRumData', value: true, origin: 'env_var' },
      { name: 'experimental.exporter', value: 'log', origin: 'env_var' },
      { name: 'experimental.runtimeId', value: true, origin: 'env_var' },
      { name: 'hostname', value: 'agent', origin: 'env_var' },
      { name: 'iast.deduplicationEnabled', value: false, origin: 'env_var' },
      { name: 'iast.enabled', value: true, origin: 'env_var' },
      { name: 'iast.maxConcurrentRequests', value: 3, origin: 'env_var' },
      { name: 'iast.maxContextOperations', value: 4, origin: 'env_var' },
      { name: 'iast.redactionEnabled', value: false, origin: 'env_var' },
      { name: 'iast.redactionNamePattern', value: 'REDACTION_NAME_PATTERN', origin: 'env_var' },
      { name: 'iast.redactionValuePattern', value: 'REDACTION_VALUE_PATTERN', origin: 'env_var' },
      { name: 'iast.requestSampling', value: 40, origin: 'env_var' },
      { name: 'iast.telemetryVerbosity', value: 'DEBUG', origin: 'env_var' },
      { name: 'isGCPFunction', value: false, origin: 'env_var' },
      { name: 'peerServiceMapping', value: { c: 'cc', d: 'dd' }, origin: 'env_var' },
      { name: 'port', value: '6218', origin: 'env_var' },
      { name: 'profiling.enabled', value: true, origin: 'env_var' },
      { name: 'protocolVersion', value: '0.5', origin: 'env_var' },
      { name: 'queryStringObfuscation', value: '.*', origin: 'env_var' },
      { name: 'remoteConfig.enabled', value: false, origin: 'env_var' },
      { name: 'remoteConfig.pollInterval', value: 42, origin: 'env_var' },
      { name: 'reportHostname', value: true, origin: 'env_var' },
      { name: 'runtimeMetrics', value: true, origin: 'env_var' },
      { name: 'sampleRate', value: 0.5, origin: 'env_var' },
      { name: 'sampler.rateLimit', value: '-1', origin: 'env_var' },
      { name: 'service', value: 'service', origin: 'env_var' },
      { name: 'spanAttributeSchema', value: 'v1', origin: 'env_var' },
      { name: 'spanRemoveIntegrationFromService', value: true, origin: 'env_var' },
      { name: 'telemetry.enabled', value: true, origin: 'env_var' },
      { name: 'telemetry.logCollection', value: true, origin: 'env_var' },
      { name: 'traceId128BitGenerationEnabled', value: true, origin: 'env_var' },
      { name: 'traceId128BitLoggingEnabled', value: true, origin: 'env_var' },
      { name: 'tracing', value: false, origin: 'env_var' },
      { name: 'version', value: '1.0.0', origin: 'env_var' }
    ])
  })

  it('should ignore empty strings', () => {
    process.env.DD_TAGS = 'service:,env:,version:'

    const config = new Config()

    expect(config).to.have.property('service', 'node')
    expect(config).to.have.property('env', undefined)
    expect(config).to.have.property('version', '')
  })

  it('should read case-insensitive booleans from environment variables', () => {
    process.env.DD_TRACING_ENABLED = 'False'
    process.env.DD_TRACE_DEBUG = 'TRUE'
    process.env.DD_RUNTIME_METRICS_ENABLED = '0'

    const config = new Config()

    expect(config).to.have.property('tracing', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.property('runtimeMetrics', false)
  })

  it('should initialize from environment variables with url taking precedence', () => {
    process.env.DD_TRACE_AGENT_URL = 'https://agent2:7777'
    process.env.DD_SITE = 'datadoghq.eu'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_TRACING_ENABLED = 'false'
    process.env.DD_TRACE_DEBUG = 'true'
    process.env.DD_SERVICE = 'service'
    process.env.DD_ENV = 'test'

    const config = new Config()

    expect(config).to.have.property('tracing', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.nested.property('dogstatsd.hostname', 'agent')
    expect(config).to.have.nested.property('url.protocol', 'https:')
    expect(config).to.have.nested.property('url.hostname', 'agent2')
    expect(config).to.have.nested.property('url.port', '7777')
    expect(config).to.have.property('site', 'datadoghq.eu')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('env', 'test')
  })

  it('should initialize from environment variables with inject/extract taking precedence', () => {
    process.env.DD_TRACE_PROPAGATION_STYLE = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'tracecontext'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'tracecontext'

    const config = new Config()

    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', ['tracecontext'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', ['tracecontext'])
  })

  it('should initialize from the options', () => {
    const logger = {}
    const tags = {
      foo: 'bar'
    }
    const logLevel = 'error'
    const config = new Config({
      enabled: false,
      debug: true,
      protocolVersion: '0.5',
      site: 'datadoghq.eu',
      hostname: 'agent',
      port: 6218,
      dogstatsd: {
        hostname: 'agent-dsd',
        port: 5218
      },
      service: 'service',
      version: '0.1.0',
      env: 'test',
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      sampleRate: 0.5,
      rateLimit: 1000,
      samplingRules: [
        { service: 'usersvc', name: 'healthcheck', sampleRate: 0.0 },
        { service: 'usersvc', sampleRate: 0.5 },
        { service: 'authsvc', sampleRate: 1.0 },
        { sampleRate: 0.1 }
      ],
      spanSamplingRules: [
        { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
        { service: 'mysql', sampleRate: 0.5 },
        { service: 'mysql', sampleRate: 1.0 },
        { sampleRate: 0.1 }
      ],
      spanAttributeSchema: 'v1',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
      peerServiceMapping: {
        d: 'dd'
      },
      serviceMapping: {
        a: 'aa',
        b: 'bb'
      },
      logger,
      tags,
      flushInterval: 5000,
      flushMinSpans: 500,
      runtimeMetrics: true,
      reportHostname: true,
      plugins: false,
      logLevel,
      tracePropagationStyle: {
        inject: ['datadog'],
        extract: ['datadog']
      },
      experimental: {
        b3: true,
        traceparent: true,
        runtimeId: true,
        exporter: 'log',
        enableGetRumData: true,
        iast: {
          enabled: true,
          requestSampling: 50,
          maxConcurrentRequests: 4,
          maxContextOperations: 5,
          deduplicationEnabled: false,
          redactionEnabled: false,
          redactionNamePattern: 'REDACTION_NAME_PATTERN',
          redactionValuePattern: 'REDACTION_VALUE_PATTERN',
          telemetryVerbosity: 'DEBUG'
        }
      },
      appsec: false,
      remoteConfig: {
        pollInterval: 42
      },
      traceId128BitGenerationEnabled: true,
      traceId128BitLoggingEnabled: true
    })

    expect(config).to.have.property('protocolVersion', '0.5')
    expect(config).to.have.property('site', 'datadoghq.eu')
    expect(config).to.have.property('hostname', 'agent')
    expect(config).to.have.property('port', '6218')
    expect(config).to.have.nested.property('dogstatsd.hostname', 'agent-dsd')
    expect(config).to.have.nested.property('dogstatsd.port', '5218')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('version', '0.1.0')
    expect(config).to.have.property('env', 'test')
    expect(config).to.have.property('sampleRate', 0.5)
    expect(config).to.have.property('logger', logger)
    expect(config.tags).to.have.property('foo', 'bar')
    expect(config.tags).to.have.property('service', 'service')
    expect(config.tags).to.have.property('version', '0.1.0')
    expect(config.tags).to.have.property('env', 'test')
    expect(config).to.have.property('clientIpEnabled', true)
    expect(config).to.have.property('clientIpHeader', 'x-true-client-ip')
    expect(config).to.have.property('flushInterval', 5000)
    expect(config).to.have.property('flushMinSpans', 500)
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config).to.have.property('reportHostname', true)
    expect(config).to.have.property('plugins', false)
    expect(config).to.have.property('logLevel', logLevel)
    expect(config).to.have.property('traceId128BitGenerationEnabled', true)
    expect(config).to.have.property('traceId128BitLoggingEnabled', true)
    expect(config).to.have.property('spanRemoveIntegrationFromService', true)
    expect(config).to.have.property('spanComputePeerService', true)
    expect(config).to.have.deep.property('peerServiceMapping', { d: 'dd' })
    expect(config).to.have.property('tags')
    expect(config.tags).to.have.property('foo', 'bar')
    expect(config.tags).to.have.property('runtime-id')
    expect(config.tags['runtime-id']).to.match(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', ['datadog'])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', ['datadog'])
    expect(config).to.have.nested.property('experimental.runtimeId', true)
    expect(config).to.have.nested.property('experimental.exporter', 'log')
    expect(config).to.have.nested.property('experimental.enableGetRumData', true)
    expect(config).to.have.nested.property('appsec.enabled', false)
    expect(config).to.have.nested.property('remoteConfig.pollInterval', 42)
    expect(config).to.have.nested.property('iast.enabled', true)
    expect(config).to.have.nested.property('iast.requestSampling', 50)
    expect(config).to.have.nested.property('iast.maxConcurrentRequests', 4)
    expect(config).to.have.nested.property('iast.maxContextOperations', 5)
    expect(config).to.have.nested.property('iast.deduplicationEnabled', false)
    expect(config).to.have.nested.property('iast.redactionEnabled', false)
    expect(config).to.have.nested.property('iast.redactionNamePattern', 'REDACTION_NAME_PATTERN')
    expect(config).to.have.nested.property('iast.redactionValuePattern', 'REDACTION_VALUE_PATTERN')
    expect(config).to.have.nested.property('iast.telemetryVerbosity', 'DEBUG')
    expect(config).to.have.deep.nested.property('sampler', {
      sampleRate: 0.5,
      rateLimit: 1000,
      rules: [
        { service: 'usersvc', name: 'healthcheck', sampleRate: 0.0 },
        { service: 'usersvc', sampleRate: 0.5 },
        { service: 'authsvc', sampleRate: 1.0 },
        { sampleRate: 0.1 }
      ],
      spanSamplingRules: [
        { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
        { service: 'mysql', sampleRate: 0.5 },
        { service: 'mysql', sampleRate: 1.0 },
        { sampleRate: 0.1 }
      ]
    })
    expect(config).to.have.deep.property('serviceMapping', {
      a: 'aa',
      b: 'bb'
    })

    expect(updateConfig).to.be.calledOnce

    expect(updateConfig.getCall(0).args[0]).to.deep.include.members([
      { name: 'appsec.enabled', value: false, origin: 'code' },
      { name: 'clientIpEnabled', value: true, origin: 'code' },
      { name: 'clientIpHeader', value: 'x-true-client-ip', origin: 'code' },
      { name: 'dogstatsd.hostname', value: 'agent-dsd', origin: 'code' },
      { name: 'dogstatsd.port', value: '5218', origin: 'code' },
      { name: 'env', value: 'test', origin: 'code' },
      { name: 'experimental.enableGetRumData', value: true, origin: 'code' },
      { name: 'experimental.exporter', value: 'log', origin: 'code' },
      { name: 'experimental.runtimeId', value: true, origin: 'code' },
      { name: 'flushInterval', value: 5000, origin: 'code' },
      { name: 'flushMinSpans', value: 500, origin: 'code' },
      { name: 'hostname', value: 'agent', origin: 'code' },
      { name: 'iast.deduplicationEnabled', value: false, origin: 'code' },
      { name: 'iast.enabled', value: true, origin: 'code' },
      { name: 'iast.maxConcurrentRequests', value: 4, origin: 'code' },
      { name: 'iast.maxContextOperations', value: 5, origin: 'code' },
      { name: 'iast.redactionEnabled', value: false, origin: 'code' },
      { name: 'iast.redactionNamePattern', value: 'REDACTION_NAME_PATTERN', origin: 'code' },
      { name: 'iast.redactionValuePattern', value: 'REDACTION_VALUE_PATTERN', origin: 'code' },
      { name: 'iast.requestSampling', value: 50, origin: 'code' },
      { name: 'iast.telemetryVerbosity', value: 'DEBUG', origin: 'code' },
      { name: 'peerServiceMapping', value: { d: 'dd' }, origin: 'code' },
      { name: 'plugins', value: false, origin: 'code' },
      { name: 'port', value: '6218', origin: 'code' },
      { name: 'protocolVersion', value: '0.5', origin: 'code' },
      { name: 'remoteConfig.pollInterval', value: 42, origin: 'code' },
      { name: 'reportHostname', value: true, origin: 'code' },
      { name: 'runtimeMetrics', value: true, origin: 'code' },
      { name: 'sampleRate', value: 0.5, origin: 'code' },
      { name: 'sampler.rateLimit', value: 1000, origin: 'code' },
      { name: 'service', value: 'service', origin: 'code' },
      { name: 'site', value: 'datadoghq.eu', origin: 'code' },
      { name: 'spanAttributeSchema', value: 'v1', origin: 'code' },
      { name: 'spanComputePeerService', value: true, origin: 'calculated' },
      { name: 'spanRemoveIntegrationFromService', value: true, origin: 'code' },
      { name: 'stats.enabled', value: false, origin: 'calculated' },
      { name: 'telemetry.logCollection', value: true, origin: 'code' },
      { name: 'traceId128BitGenerationEnabled', value: true, origin: 'code' },
      { name: 'traceId128BitLoggingEnabled', value: true, origin: 'code' },
      { name: 'version', value: '0.1.0', origin: 'code' }
    ])
  })

  it('should initialize from the options with url taking precedence', () => {
    const logger = {}
    const tags = { foo: 'bar' }
    const config = new Config({
      hostname: 'agent',
      url: 'https://agent2:7777',
      site: 'datadoghq.eu',
      port: 6218,
      service: 'service',
      env: 'test',
      sampleRate: 0.5,
      logger,
      tags,
      flushInterval: 5000,
      flushMinSpans: 500,
      plugins: false
    })

    expect(config).to.have.nested.property('url.protocol', 'https:')
    expect(config).to.have.nested.property('url.hostname', 'agent2')
    expect(config).to.have.nested.property('url.port', '7777')
    expect(config).to.have.property('site', 'datadoghq.eu')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('env', 'test')
    expect(config).to.have.property('sampleRate', 0.5)
    expect(config).to.have.property('logger', logger)
    expect(config.tags).to.have.property('foo', 'bar')
    expect(config).to.have.property('flushInterval', 5000)
    expect(config).to.have.property('flushMinSpans', 500)
    expect(config).to.have.property('plugins', false)
  })

  it('should warn if mixing shared and extract propagation style env vars', () => {
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE = 'datadog'

    // eslint-disable-next-line no-new
    new Config()

    expect(log.warn).to.have.been.calledWith('Use either the DD_TRACE_PROPAGATION_STYLE ' +
      'environment variable or separate DD_TRACE_PROPAGATION_STYLE_INJECT and ' +
      'DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables')
  })

  it('should warn if mixing shared and inject propagation style env vars', () => {
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE = 'datadog'

    // eslint-disable-next-line no-new
    new Config()

    expect(log.warn).to.have.been.calledWith('Use either the DD_TRACE_PROPAGATION_STYLE ' +
      'environment variable or separate DD_TRACE_PROPAGATION_STYLE_INJECT and ' +
      'DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables')
  })

  it('should warn if defaulting to v0 span attribute schema', () => {
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'foo'

    const config = new Config()

    expect(log.warn).to.have.been.calledWith('Unexpected input for config.spanAttributeSchema, picked default v0')
    expect(config).to.have.property('spanAttributeSchema', 'v0')
  })

  context('peer service tagging', () => {
    it('should activate peer service only if explicitly true in v0', () => {
      process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v0'
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'true'
      let config = new Config()
      expect(config).to.have.property('spanComputePeerService', true)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'foo'
      config = new Config()
      expect(config).to.have.property('spanComputePeerService', false)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'false'
      config = new Config()
      expect(config).to.have.property('spanComputePeerService', false)

      delete process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
      config = new Config()
      expect(config).to.have.property('spanComputePeerService', false)
    })

    it('should activate peer service in v1 unless explicitly false', () => {
      process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v1'
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'false'
      let config = new Config()
      expect(config).to.have.property('spanComputePeerService', false)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'foo'
      config = new Config()
      expect(config).to.have.property('spanComputePeerService', true)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'true'
      config = new Config()
      expect(config).to.have.property('spanComputePeerService', true)

      delete process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
      config = new Config()
      expect(config).to.have.property('spanComputePeerService', true)
    })
  })

  it('should give priority to the common agent environment variable', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'trace-agent'
    process.env.DD_AGENT_HOST = 'agent'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:foo'
    process.env.DD_TAGS = 'foo:bar,baz:qux'

    const config = new Config()

    expect(config).to.have.property('hostname', 'agent')
    expect(config.tags).to.include({ foo: 'foo', baz: 'qux' })
  })

  it('should give priority to the options', () => {
    process.env.DD_TRACE_AGENT_URL = 'https://agent2:6218'
    process.env.DD_SITE = 'datadoghq.eu'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_DOGSTATSD_PORT = '5218'
    process.env.DD_TRACE_AGENT_PROTOCOL_VERSION = '0.4'
    process.env.DD_TRACE_PARTIAL_FLUSH_MIN_SPANS = 2000
    process.env.DD_SERVICE = 'service'
    process.env.DD_SERVICE_MAPPING = 'a:aa'
    process.env.DD_TRACE_PEER_SERVICE_MAPPING = 'c:cc'
    process.env.DD_VERSION = '0.0.0'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
    process.env.DD_ENV = 'test'
    process.env.DD_API_KEY = '123'
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v0'
    process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'false'
    process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = 'false'
    process.env.DD_TRACE_CLIENT_IP_ENABLED = 'false'
    process.env.DD_TRACE_CLIENT_IP_HEADER = 'foo-bar-header'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:bar,baz:qux'
    process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_TRACEPARENT_ENABLED = 'true'
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'datadog'
    process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'log'
    process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_INTERNAL_ERRORS_ENABLED = 'true'
    process.env.DD_APPSEC_ENABLED = 'false'
    process.env.DD_APPSEC_RULES = RECOMMENDED_JSON_PATH
    process.env.DD_APPSEC_TRACE_RATE_LIMIT = 11
    process.env.DD_APPSEC_WAF_TIMEOUT = 11
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = '^$'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = '^$'
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = BLOCKED_TEMPLATE_JSON_PATH // note the inversion between
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_HTML_PATH // json and html here
    process.env.DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_JSON_PATH // json and html here
    process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = 'disabled'
    process.env.DD_API_SECURITY_ENABLED = 'false'
    process.env.DD_API_SECURITY_REQUEST_SAMPLE_RATE = 0.5
    process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = 11
    process.env.DD_IAST_ENABLED = 'false'
    process.env.DD_IAST_REDACTION_NAME_PATTERN = 'name_pattern_to_be_overriden_by_options'
    process.env.DD_IAST_REDACTION_VALUE_PATTERN = 'value_pattern_to_be_overriden_by_options'
    process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = 'true'
    process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = 'true'

    const config = new Config({
      protocolVersion: '0.5',
      protocol: 'https',
      site: 'datadoghq.com',
      hostname: 'server',
      port: 7777,
      dogstatsd: {
        port: 8888
      },
      runtimeMetrics: false,
      reportHostname: false,
      flushMinSpans: 500,
      service: 'test',
      version: '1.0.0',
      env: 'development',
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      tags: {
        foo: 'foo'
      },
      serviceMapping: {
        b: 'bb'
      },
      spanAttributeSchema: 'v1',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
      peerServiceMapping: {
        d: 'dd'
      },
      tracePropagationStyle: {
        inject: [],
        extract: []
      },
      experimental: {
        b3: false,
        traceparent: false,
        runtimeId: false,
        exporter: 'agent',
        enableGetRumData: false,
        iast: {
          enabled: true,
          redactionNamePattern: 'REDACTION_NAME_PATTERN',
          redactionValuePattern: 'REDACTION_VALUE_PATTERN'
        }
      },
      appsec: {
        enabled: true,
        rules: RULES_JSON_PATH,
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        blockedTemplateHtml: BLOCKED_TEMPLATE_HTML_PATH,
        blockedTemplateJson: BLOCKED_TEMPLATE_JSON_PATH,
        blockedTemplateGraphql: BLOCKED_TEMPLATE_GRAPHQL_PATH,
        eventTracking: {
          mode: 'safe'
        },
        apiSecurity: {
          enabled: true,
          requestSampling: 1.0
        }
      },
      remoteConfig: {
        pollInterval: 42
      },
      traceId128BitGenerationEnabled: false,
      traceId128BitLoggingEnabled: false
    })

    expect(config).to.have.property('protocolVersion', '0.5')
    expect(config).to.have.nested.property('url.protocol', 'https:')
    expect(config).to.have.nested.property('url.hostname', 'agent2')
    expect(config).to.have.nested.property('url.port', '6218')
    expect(config).to.have.nested.property('dogstatsd.hostname', 'server')
    expect(config).to.have.nested.property('dogstatsd.port', '8888')
    expect(config).to.have.property('site', 'datadoghq.com')
    expect(config).to.have.property('runtimeMetrics', false)
    expect(config).to.have.property('reportHostname', false)
    expect(config).to.have.property('flushMinSpans', 500)
    expect(config).to.have.property('service', 'test')
    expect(config).to.have.property('version', '1.0.0')
    expect(config).to.have.property('env', 'development')
    expect(config).to.have.property('clientIpEnabled', true)
    expect(config).to.have.property('clientIpHeader', 'x-true-client-ip')
    expect(config).to.have.property('traceId128BitGenerationEnabled', false)
    expect(config).to.have.property('traceId128BitLoggingEnabled', false)
    expect(config.tags).to.include({ foo: 'foo' })
    expect(config.tags).to.include({ service: 'test', version: '1.0.0', env: 'development' })
    expect(config).to.have.deep.property('serviceMapping', { b: 'bb' })
    expect(config).to.have.property('spanAttributeSchema', 'v1')
    expect(config).to.have.property('spanRemoveIntegrationFromService', true)
    expect(config).to.have.property('spanComputePeerService', true)
    expect(config).to.have.deep.property('peerServiceMapping', { d: 'dd' })
    expect(config).to.have.nested.deep.property('tracePropagationStyle.inject', [])
    expect(config).to.have.nested.deep.property('tracePropagationStyle.extract', [])
    expect(config).to.have.nested.property('experimental.runtimeId', false)
    expect(config).to.have.nested.property('experimental.exporter', 'agent')
    expect(config).to.have.nested.property('experimental.enableGetRumData', false)
    expect(config).to.have.nested.property('appsec.enabled', true)
    expect(config).to.have.nested.property('appsec.rules', RULES_JSON_PATH)
    expect(config).to.have.nested.property('appsec.rateLimit', 42)
    expect(config).to.have.nested.property('appsec.wafTimeout', 42)
    expect(config).to.have.nested.property('appsec.obfuscatorKeyRegex', '.*')
    expect(config).to.have.nested.property('appsec.obfuscatorValueRegex', '.*')
    expect(config).to.have.nested.property('appsec.blockedTemplateHtml', BLOCKED_TEMPLATE_HTML)
    expect(config).to.have.nested.property('appsec.blockedTemplateJson', BLOCKED_TEMPLATE_JSON)
    expect(config).to.have.nested.property('appsec.blockedTemplateGraphql', BLOCKED_TEMPLATE_GRAPHQL)
    expect(config).to.have.nested.property('appsec.eventTracking.enabled', true)
    expect(config).to.have.nested.property('appsec.eventTracking.mode', 'safe')
    expect(config).to.have.nested.property('appsec.apiSecurity.enabled', true)
    expect(config).to.have.nested.property('appsec.apiSecurity.requestSampling', 1.0)
    expect(config).to.have.nested.property('remoteConfig.pollInterval', 42)
    expect(config).to.have.nested.property('iast.enabled', true)
    expect(config).to.have.nested.property('iast.requestSampling', 30)
    expect(config).to.have.nested.property('iast.maxConcurrentRequests', 2)
    expect(config).to.have.nested.property('iast.maxContextOperations', 2)
    expect(config).to.have.nested.property('iast.deduplicationEnabled', true)
    expect(config).to.have.nested.property('iast.redactionEnabled', true)
    expect(config).to.have.nested.property('iast.redactionNamePattern', 'REDACTION_NAME_PATTERN')
    expect(config).to.have.nested.property('iast.redactionValuePattern', 'REDACTION_VALUE_PATTERN')
  })

  it('should give priority to non-experimental options', () => {
    const config = new Config({
      appsec: {
        enabled: true,
        rules: undefined,
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        blockedTemplateHtml: undefined,
        blockedTemplateJson: undefined,
        blockedTemplateGraphql: undefined,
        eventTracking: {
          mode: 'disabled'
        },
        apiSecurity: {
          enabled: true,
          requestSampling: 1.0
        }
      },
      experimental: {
        appsec: {
          enabled: false,
          rules: RULES_JSON_PATH,
          rateLimit: 11,
          wafTimeout: 11,
          obfuscatorKeyRegex: '^$',
          obfuscatorValueRegex: '^$',
          blockedTemplateHtml: BLOCKED_TEMPLATE_HTML_PATH,
          blockedTemplateJson: BLOCKED_TEMPLATE_JSON_PATH,
          blockedTemplateGraphql: BLOCKED_TEMPLATE_GRAPHQL_PATH,
          eventTracking: {
            mode: 'safe'
          },
          apiSecurity: {
            enabled: false,
            requestSampling: 0.5
          }
        }
      }
    })

    expect(config).to.have.deep.property('appsec', {
      enabled: true,
      rules: undefined,
      rateLimit: 42,
      wafTimeout: 42,
      obfuscatorKeyRegex: '.*',
      obfuscatorValueRegex: '.*',
      blockedTemplateHtml: undefined,
      blockedTemplateJson: undefined,
      blockedTemplateGraphql: undefined,
      eventTracking: {
        enabled: false,
        mode: 'disabled'
      },
      apiSecurity: {
        enabled: true,
        requestSampling: 1.0
      },
      sca: {
        enabled: null
      }
    })
  })

  it('should give priority to the options especially url', () => {
    process.env.DD_TRACE_AGENT_URL = 'http://agent2:6218'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_SERVICE_NAME = 'service'
    process.env.DD_ENV = 'test'

    const config = new Config({
      url: 'https://agent3:7778',
      protocol: 'http',
      hostname: 'server',
      port: 7777,
      service: 'test',
      env: 'development'
    })

    expect(config).to.have.nested.property('url.protocol', 'https:')
    expect(config).to.have.nested.property('url.hostname', 'agent3')
    expect(config).to.have.nested.property('url.port', '7778')
    expect(config).to.have.property('service', 'test')
    expect(config).to.have.property('env', 'development')
  })

  it('should give priority to individual options over tags', () => {
    process.env.DD_SERVICE = 'test'
    process.env.DD_ENV = 'dev'
    process.env.DD_VERSION = '1.0.0'
    process.env.DD_TAGS = 'service=foo,env=bar,version=0.0.0'

    const config = new Config()

    expect(config.tags).to.include({
      service: 'test',
      env: 'dev',
      version: '1.0.0'
    })
  })

  it('should sanitize the sample rate to be between 0 and 1', () => {
    expect(new Config({ sampleRate: -1 })).to.have.property('sampleRate', 0)
    expect(new Config({ sampleRate: 2 })).to.have.property('sampleRate', 1)
    expect(new Config({ sampleRate: NaN })).to.have.property('sampleRate', undefined)
  })

  it('should ignore empty service names', () => {
    process.env.DD_SERVICE = ''

    const config = new Config()

    expect(config.tags).to.include({
      service: 'node'
    })
  })

  it('should support tags for setting primary fields', () => {
    const config = new Config({
      tags: {
        service: 'service',
        env: 'test',
        version: '0.1.0'
      }
    })

    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('version', '0.1.0')
    expect(config).to.have.property('env', 'test')
  })

  it('should trim whitespace characters around keys', () => {
    process.env.DD_TAGS = 'foo:bar, baz:qux'

    const config = new Config()

    expect(config.tags).to.include({ foo: 'bar', baz: 'qux' })
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if AWS_LAMBDA_FUNCTION_NAME is present', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-great-lambda-function'

    const config = new Config()

    expect(config.telemetry.enabled).to.be.false
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if FUNCTION_NAME and GCP_PROJECT are present', () => {
    // FUNCTION_NAME and GCP_PROJECT env vars indicate a gcp function with a deprecated runtime
    process.env.FUNCTION_NAME = 'function_name'
    process.env.GCP_PROJECT = 'project_name'

    const config = new Config()

    expect(config.telemetry.enabled).to.be.false
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if K_SERVICE and FUNCTION_TARGET are present', () => {
    // K_SERVICE and FUNCTION_TARGET env vars indicate a gcp function with a newer runtime
    process.env.K_SERVICE = 'function_name'
    process.env.FUNCTION_TARGET = 'function_target'

    const config = new Config()

    expect(config.telemetry.enabled).to.be.false
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if Azure Consumption Plan Function', () => {
    // AzureWebJobsScriptRoot and FUNCTIONS_EXTENSION_VERSION env vars indicate an azure function
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'
    process.env.WEBSITE_SKU = 'Dynamic'

    const config = new Config()

    expect(config.telemetry.enabled).to.be.false
  })

  it('should set telemetry default values', () => {
    const config = new Config()

    expect(config.telemetry).to.not.be.undefined
    expect(config.telemetry.enabled).to.be.true
    expect(config.telemetry.heartbeatInterval).to.eq(60000)
    expect(config.telemetry.logCollection).to.be.false
    expect(config.telemetry.debug).to.be.false
    expect(config.telemetry.metrics).to.be.true
  })

  it('should set DD_TELEMETRY_HEARTBEAT_INTERVAL', () => {
    const origTelemetryHeartbeatIntervalValue = process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL
    process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL = '42'

    const config = new Config()

    expect(config.telemetry.heartbeatInterval).to.eq(42000)

    process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL = origTelemetryHeartbeatIntervalValue
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED', () => {
    const origTraceTelemetryValue = process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED
    process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

    const config = new Config()

    expect(config.telemetry.enabled).to.be.false

    process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = origTraceTelemetryValue
  })

  it('should not set DD_TELEMETRY_METRICS_ENABLED', () => {
    const origTelemetryMetricsEnabledValue = process.env.DD_TELEMETRY_METRICS_ENABLED
    process.env.DD_TELEMETRY_METRICS_ENABLED = 'false'

    const config = new Config()

    expect(config.telemetry.metrics).to.be.false

    process.env.DD_TELEMETRY_METRICS_ENABLED = origTelemetryMetricsEnabledValue
  })

  it('should not set DD_TELEMETRY_LOG_COLLECTION_ENABLED', () => {
    const origLogsValue = process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED
    process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED = 'false'

    const config = new Config()

    expect(config.telemetry.logCollection).to.be.false

    process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED = origLogsValue
  })

  it('should set DD_TELEMETRY_LOG_COLLECTION_ENABLED if DD_IAST_ENABLED', () => {
    const origIastEnabledValue = process.env.DD_IAST_ENABLED
    process.env.DD_IAST_ENABLED = 'true'

    const config = new Config()

    expect(config.telemetry.logCollection).to.be.true

    process.env.DD_IAST_ENABLED = origIastEnabledValue
  })

  it('should set DD_TELEMETRY_DEBUG', () => {
    const origTelemetryDebugValue = process.env.DD_TELEMETRY_DEBUG
    process.env.DD_TELEMETRY_DEBUG = 'true'

    const config = new Config()

    expect(config.telemetry.debug).to.be.true

    process.env.DD_TELEMETRY_DEBUG = origTelemetryDebugValue
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if AWS_LAMBDA_FUNCTION_NAME is present', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-great-lambda-function'

    const config = new Config()

    expect(config.remoteConfig.enabled).to.be.false
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if FUNCTION_NAME and GCP_PROJECT are present', () => {
    process.env.FUNCTION_NAME = 'function_name'
    process.env.GCP_PROJECT = 'project_name'

    const config = new Config()

    expect(config.remoteConfig.enabled).to.be.false
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if K_SERVICE and FUNCTION_TARGET are present', () => {
    process.env.K_SERVICE = 'function_name'
    process.env.FUNCTION_TARGET = 'function_target'

    const config = new Config()

    expect(config.remoteConfig.enabled).to.be.false
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if Azure Functions env vars are present', () => {
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'
    process.env.WEBSITE_SKU = 'Dynamic'

    const config = new Config()

    expect(config.remoteConfig.enabled).to.be.false
  })

  it('should send empty array when remote config is called on empty options', () => {
    const config = new Config()

    config.configure({}, true)

    expect(updateConfig).to.be.calledTwice
    expect(updateConfig.getCall(1).args[0]).to.deep.equal([])
  })

  it('should send remote config changes to telemetry', () => {
    const config = new Config()

    config.configure({
      tracing_sampling_rate: 0
    }, true)

    expect(updateConfig.getCall(1).args[0]).to.deep.equal([
      { name: 'sampleRate', value: 0, origin: 'remote_config' }
    ])
  })

  it('should have consistent runtime-id after remote configuration updates tags', () => {
    const config = new Config()
    const runtimeId = config.tags['runtime-id']
    config.configure({
      tracing_tags: { foo: 'bar' }
    }, true)

    expect(config.tags).to.have.property('foo', 'bar')
    expect(config.tags).to.have.property('runtime-id', runtimeId)
  })

  it('should ignore invalid iast.requestSampling', () => {
    const config = new Config({
      experimental: {
        iast: {
          requestSampling: 105
        }
      }
    })
    expect(config.iast.requestSampling).to.be.equals(30)
  })

  it('should load span sampling rules from json file', () => {
    const path = './fixtures/config/span-sampling-rules.json'
    process.env.DD_SPAN_SAMPLING_RULES_FILE = require.resolve(path)

    const config = new Config()

    expect(config.sampler).to.have.deep.nested.property('spanSamplingRules', [
      { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
      { service: 'mysql', sampleRate: 0.5 },
      { service: 'mysql', sampleRate: 1.0 },
      { sampleRate: 0.1 }
    ])
  })

  it('should skip appsec config files if they do not exist', () => {
    const error = new Error('file not found')
    fs.readFileSync = () => { throw error }

    const Config = proxyquire('../src/config', {
      './pkg': pkg,
      './log': log,
      fs,
      os
    })

    const config = new Config({
      appsec: {
        enabled: true,
        rules: 'path/to/rules.json',
        blockedTemplateHtml: 'DOES_NOT_EXIST.html',
        blockedTemplateJson: 'DOES_NOT_EXIST.json',
        blockedTemplateGraphql: 'DOES_NOT_EXIST.json'
      }
    })

    expect(log.error).to.be.callCount(3)
    expect(log.error.firstCall).to.have.been.calledWithExactly(error)
    expect(log.error.secondCall).to.have.been.calledWithExactly(error)
    expect(log.error.thirdCall).to.have.been.calledWithExactly(error)

    expect(config.appsec.enabled).to.be.true
    expect(config.appsec.rules).to.eq('path/to/rules.json')
    expect(config.appsec.blockedTemplateHtml).to.be.undefined
    expect(config.appsec.blockedTemplateJson).to.be.undefined
    expect(config.appsec.blockedTemplateGraphql).to.be.undefined
  })

  it('should enable api security with DD_EXPERIMENTAL_API_SECURITY_ENABLED', () => {
    process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED = 'true'

    const config = new Config()

    expect(config.appsec.apiSecurity.enabled).to.be.true
  })

  it('should disable api security with DD_EXPERIMENTAL_API_SECURITY_ENABLED', () => {
    process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED = 'false'

    const config = new Config()

    expect(config.appsec.apiSecurity.enabled).to.be.false
  })

  it('should ignore DD_EXPERIMENTAL_API_SECURITY_ENABLED with DD_API_SECURITY_ENABLED=true', () => {
    process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED = 'false'
    process.env.DD_API_SECURITY_ENABLED = 'true'

    const config = new Config()

    expect(config.appsec.apiSecurity.enabled).to.be.true
  })

  context('auto configuration w/ unix domain sockets', () => {
    context('on windows', () => {
      it('should not be used', () => {
        osType = 'Windows_NT'
        const config = new Config()

        expect(config.url).to.be.undefined
      })
    })
    context('socket does not exist', () => {
      it('should not be used', () => {
        const config = new Config()

        expect(config.url).to.be.undefined
      })
    })
    context('socket exists', () => {
      beforeEach(() => {
        existsSyncReturn = true
      })

      it('should be used when no options and no env vars', () => {
        const config = new Config()

        expect(existsSyncParam).to.equal('/var/run/datadog/apm.socket')
        expect(config.url.toString()).to.equal('unix:///var/run/datadog/apm.socket')
      })

      it('should not be used when DD_TRACE_AGENT_URL provided', () => {
        process.env.DD_TRACE_AGENT_URL = 'https://example.com/'

        const config = new Config()

        expect(config.url.toString()).to.equal('https://example.com/')
      })

      it('should not be used when DD_TRACE_URL provided', () => {
        process.env.DD_TRACE_URL = 'https://example.com/'

        const config = new Config()

        expect(config.url.toString()).to.equal('https://example.com/')
      })

      it('should not be used when options.url provided', () => {
        const config = new Config({ url: 'https://example.com/' })

        expect(config.url.toString()).to.equal('https://example.com/')
      })

      it('should not be used when DD_TRACE_AGENT_PORT provided', () => {
        process.env.DD_TRACE_AGENT_PORT = 12345

        const config = new Config()

        expect(config.url).to.be.undefined
      })

      it('should not be used when options.port provided', () => {
        const config = new Config({ port: 12345 })

        expect(config.url).to.be.undefined
      })

      it('should not be used when DD_TRACE_AGENT_HOSTNAME provided', () => {
        process.env.DD_TRACE_AGENT_HOSTNAME = 'example.com'

        const config = new Config()

        expect(config.url).to.be.undefined
      })

      it('should not be used when DD_AGENT_HOST provided', () => {
        process.env.DD_AGENT_HOST = 'example.com'

        const config = new Config()

        expect(config.url).to.be.undefined
      })

      it('should not be used when options.hostname provided', () => {
        const config = new Config({ hostname: 'example.com' })

        expect(config.url).to.be.undefined
      })
    })
  })

  context('ci visibility config', () => {
    let options = {}
    beforeEach(() => {
      delete process.env.DD_CIVISIBILITY_ITR_ENABLED
      delete process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED
      delete process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED
      delete process.env.DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED
      delete process.env.JEST_WORKER_ID
      options = {}
    })
    context('ci visibility mode is enabled', () => {
      beforeEach(() => {
        options = { isCiVisibility: true }
      })
      it('should activate git upload by default', () => {
        const config = new Config(options)
        expect(config).to.have.property('isGitUploadEnabled', true)
      })
      it('should disable git upload if the DD_CIVISIBILITY_GIT_UPLOAD_ENABLED is set to false', () => {
        process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = 'false'
        const config = new Config(options)
        expect(config).to.have.property('isGitUploadEnabled', false)
      })
      it('should activate ITR by default', () => {
        const config = new Config(options)
        expect(config).to.have.property('isIntelligentTestRunnerEnabled', true)
      })
      it('should disable ITR if DD_CIVISIBILITY_ITR_ENABLED is set to false', () => {
        process.env.DD_CIVISIBILITY_ITR_ENABLED = 'false'
        const config = new Config(options)
        expect(config).to.have.property('isIntelligentTestRunnerEnabled', false)
      })
      it('should disable manual testing API by default', () => {
        const config = new Config(options)
        expect(config).to.have.property('isManualApiEnabled', false)
      })
      it('should enable manual testing API if DD_CIVISIBILITY_MANUAL_API_ENABLED is passed', () => {
        process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED = 'true'
        const config = new Config(options)
        expect(config).to.have.property('isManualApiEnabled', true)
      })
      it('should disable memcached command tagging by default', () => {
        const config = new Config(options)
        expect(config).to.have.property('memcachedCommandEnabled', false)
      })
      it('should enable memcached command tagging if DD_TRACE_MEMCACHED_COMMAND_ENABLED is enabled', () => {
        process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED = 'true'
        const config = new Config(options)
        expect(config).to.have.property('memcachedCommandEnabled', true)
      })
      it('should enable telemetry', () => {
        const config = new Config(options)
        expect(config).to.nested.property('telemetry.enabled', true)
      })
      it('should enable early flake detection by default', () => {
        const config = new Config(options)
        expect(config).to.have.property('isEarlyFlakeDetectionEnabled', true)
      })
      it('should disable early flake detection if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', () => {
        process.env.DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED = 'false'
        const config = new Config(options)
        expect(config).to.have.property('isEarlyFlakeDetectionEnabled', false)
      })
    })
    context('ci visibility mode is not enabled', () => {
      it('should not activate intelligent test runner or git metadata upload', () => {
        process.env.DD_CIVISIBILITY_ITR_ENABLED = 'true'
        process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = 'true'
        const config = new Config(options)
        expect(config).to.have.property('isIntelligentTestRunnerEnabled', false)
        expect(config).to.have.property('isGitUploadEnabled', false)
      })
    })
    it('disables telemetry if inside a jest worker', () => {
      process.env.JEST_WORKER_ID = '1'
      const config = new Config(options)
      expect(config.telemetry.enabled).to.be.false
    })
  })

  context('sci embedding', () => {
    const DUMMY_COMMIT_SHA = 'b7b5dfa992008c77ab3f8a10eb8711e0092445b0'
    const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/dd-trace-js.git'
    let ddTags
    beforeEach(() => {
      ddTags = process.env.DD_TAGS
    })
    afterEach(() => {
      delete process.env.DD_GIT_PROPERTIES_FILE
      delete process.env.DD_GIT_COMMIT_SHA
      delete process.env.DD_GIT_REPOSITORY_URL
      delete process.env.DD_TRACE_GIT_METADATA_ENABLED
      process.env.DD_TAGS = ddTags
    })
    it('reads DD_GIT_* env vars', () => {
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL
      const config = new Config({})
      expect(config).to.have.property('commitSHA', DUMMY_COMMIT_SHA)
      expect(config).to.have.property('repositoryUrl', DUMMY_REPOSITORY_URL)
    })
    it('reads DD_GIT_* env vars and filters out user data', () => {
      process.env.DD_GIT_REPOSITORY_URL = 'https://user:password@github.com/DataDog/dd-trace-js.git'
      const config = new Config({})
      expect(config).to.have.property('repositoryUrl', 'https://github.com/DataDog/dd-trace-js.git')
    })
    it('reads DD_TAGS env var', () => {
      process.env.DD_TAGS = `git.commit.sha:${DUMMY_COMMIT_SHA},git.repository_url:${DUMMY_REPOSITORY_URL}`
      process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL
      const config = new Config({})
      expect(config).to.have.property('commitSHA', DUMMY_COMMIT_SHA)
      expect(config).to.have.property('repositoryUrl', DUMMY_REPOSITORY_URL)
    })
    it('reads git.properties if it is available', () => {
      process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
      const config = new Config({})
      expect(config).to.have.property('commitSHA', '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(config).to.have.property('repositoryUrl', DUMMY_REPOSITORY_URL)
    })
    it('does not crash if git.properties is not available', () => {
      process.env.DD_GIT_PROPERTIES_FILE = '/does/not/exist'
      const config = new Config({})
      expect(config).to.have.property('commitSHA', undefined)
      expect(config).to.have.property('repositoryUrl', undefined)
    })
    it('does not read git.properties if env vars are passed', () => {
      process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      process.env.DD_GIT_REPOSITORY_URL = 'https://github.com:env-var/dd-trace-js.git'
      const config = new Config({})
      expect(config).to.have.property('commitSHA', DUMMY_COMMIT_SHA)
      expect(config).to.have.property('repositoryUrl', 'https://github.com:env-var/dd-trace-js.git')
    })
    it('still reads git.properties if one of the env vars is missing', () => {
      process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      const config = new Config({})
      expect(config).to.have.property('commitSHA', DUMMY_COMMIT_SHA)
      expect(config).to.have.property('repositoryUrl', DUMMY_REPOSITORY_URL)
    })
    it('reads git.properties and filters out credentials', () => {
      process.env.DD_GIT_PROPERTIES_FILE = require.resolve('./fixtures/config/git.properties.credentials')
      const config = new Config({})
      expect(config).to.have.property('commitSHA', '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      expect(config).to.have.property('repositoryUrl', 'https://github.com/datadog/dd-trace-js')
    })
    it('does not read git metadata if DD_TRACE_GIT_METADATA_ENABLED is false', () => {
      process.env.DD_TRACE_GIT_METADATA_ENABLED = 'false'
      const config = new Config({})
      expect(config).not.to.have.property('commitSHA')
      expect(config).not.to.have.property('repositoryUrl')
    })
  })
  it('should sanitize values for API Security sampling between 0 and 1', () => {
    expect(new Config({
      appsec: {
        apiSecurity: {
          enabled: true,
          requestSampling: 5
        }
      }
    })).to.have.nested.property('appsec.apiSecurity.requestSampling', 1)

    expect(new Config({
      appsec: {
        apiSecurity: {
          enabled: true,
          requestSampling: -5
        }
      }
    })).to.have.nested.property('appsec.apiSecurity.requestSampling', 0)

    expect(new Config({
      appsec: {
        apiSecurity: {
          enabled: true,
          requestSampling: 0.1
        }
      }
    })).to.have.nested.property('appsec.apiSecurity.requestSampling', 0.1)
  })
})
