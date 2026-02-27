'use strict'

const { readFileSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const os = require('node:os')

const sinon = require('sinon')
const { it, describe, beforeEach, afterEach } = require('mocha')
const context = describe
const proxyquire = require('proxyquire')

require('../setup/core')
const defaults = require('../../src/config/defaults')
const { getEnvironmentVariable, getEnvironmentVariables } = require('../../src/config/helper')
const { assertObjectContains } = require('../../../../integration-tests/helpers')
const { DD_MAJOR } = require('../../../../version')
const StableConfig = require('../../src/config/stable')

const GRPC_CLIENT_ERROR_STATUSES = defaults['grpc.client.error.statuses']
const GRPC_SERVER_ERROR_STATUSES = defaults['grpc.server.error.statuses']

describe('Config', () => {
  let getConfig
  let log
  let pkg
  let env
  let fs
  let existsSyncParam
  let existsSyncReturn
  let updateConfig

  const RECOMMENDED_JSON_PATH = require.resolve('../../src/appsec/recommended.json')
  const RULES_JSON_PATH = require.resolve('../fixtures/config/appsec-rules.json')
  const BLOCKED_TEMPLATE_HTML_PATH = require.resolve('../fixtures/config/appsec-blocked-template.html')
  const BLOCKED_TEMPLATE_HTML = readFileSync(BLOCKED_TEMPLATE_HTML_PATH, { encoding: 'utf8' })
  const BLOCKED_TEMPLATE_JSON_PATH = require.resolve('../fixtures/config/appsec-blocked-template.json')
  const BLOCKED_TEMPLATE_JSON = readFileSync(BLOCKED_TEMPLATE_JSON_PATH, { encoding: 'utf8' })
  const BLOCKED_TEMPLATE_GRAPHQL_PATH = require.resolve('../fixtures/config/appsec-blocked-graphql-template.json')
  const BLOCKED_TEMPLATE_GRAPHQL = readFileSync(BLOCKED_TEMPLATE_GRAPHQL_PATH, { encoding: 'utf8' })

  const comparator = (a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin)

  function reloadLoggerAndConfig () {
    log = proxyquire('../../src/log', {})
    log.use = sinon.spy()
    log.toggle = sinon.spy()
    log.warn = sinon.spy()
    log.error = sinon.spy()

    const configDefaults = proxyquire('../../src/config/defaults', {
      '../pkg': pkg,
    })

    // Reload the config module with each call to getConfig to ensure we get a new instance of the config.
    getConfig = (options) => {
      const supportedConfigurations = proxyquire.noPreserveCache()('../../src/config/supported-configurations.json', {})
      const configHelper = proxyquire.noPreserveCache()('../../src/config/helper', {
        './supported-configurations.json': supportedConfigurations,
      })
      const serverless = proxyquire.noPreserveCache()('../../src/serverless', {})
      return proxyquire.noPreserveCache()('../../src/config', {
        './defaults': configDefaults,
        '../log': log,
        '../telemetry': { updateConfig },
        '../serverless': serverless,
        'node:fs': fs,
        './helper': configHelper,
      })(options)
    }
  }

  beforeEach(() => {
    pkg = {
      name: '',
      version: '',
    }

    updateConfig = sinon.stub()

    env = process.env
    process.env = {}
    fs = {
      existsSync: (param) => {
        existsSyncParam = param
        return existsSyncReturn
      },
      rmSync,
      mkdtempSync,
      writeFileSync,
    }

    reloadLoggerAndConfig()
  })

  afterEach(() => {
    updateConfig.reset()
    process.env = env
    existsSyncParam = undefined
  })

  describe('config-helper', () => {
    it('should throw when accessing unknown configuration', () => {
      assert.throws(
        () => getEnvironmentVariable('DD_UNKNOWN_CONFIG'),
        /Missing DD_UNKNOWN_CONFIG env\/configuration in "supported-configurations.json" file./
      )
    })

    it('should return aliased value', () => {
      process.env.DATADOG_API_KEY = '12345'
      assert.throws(() => getEnvironmentVariable('DATADOG_API_KEY'), {
        message: /Missing DATADOG_API_KEY env\/configuration in "supported-configurations.json" file./,
      })
      assert.strictEqual(getEnvironmentVariable('DD_API_KEY'), '12345')
      const { DD_API_KEY, DATADOG_API_KEY } = getEnvironmentVariables()
      assert.strictEqual(DATADOG_API_KEY, undefined)
      assert.strictEqual(DD_API_KEY, getEnvironmentVariable('DD_API_KEY'))
      delete process.env.DATADOG_API_KEY
    })

    it('should log deprecation warning for deprecated configurations', async () => {
      process.env.DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED = 'true'
      getEnvironmentVariables()
      const [warning] = await once(process, 'warning')
      assert.strictEqual(warning.name, 'DeprecationWarning')
      assert.match(
        warning.message,
        /variable DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED .+ DD_PROFILING_ENDPOINT_COLLECTION_ENABLED instead/
      )
      assert.strictEqual(warning.code, 'DATADOG_DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED')
    })

    it('should set new runtimeMetricsRuntimeId from deprecated DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED', async () => {
      process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED = 'true'
      assert.strictEqual(process.env.DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED, undefined)
      const config = getConfig()
      assert.strictEqual(config.runtimeMetricsRuntimeId, true)
      assert.strictEqual(getEnvironmentVariable('DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED'), 'true')
      delete process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED

      const [warning] = await once(process, 'warning')
      assert.strictEqual(warning.name, 'DeprecationWarning')
      assert.match(
        warning.message,
        /variable DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED .+ DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED instead/
      )
    })

    it('should pass through random envs', async () => {
      process.env.FOOBAR = 'true'
      const { FOOBAR } = getEnvironmentVariables()
      assert.strictEqual(FOOBAR, 'true')
      assert.strictEqual(getEnvironmentVariable('FOOBAR'), FOOBAR)
      delete process.env.FOOBAR
    })
  })

  it('should initialize its own logging config based off the loggers config', () => {
    process.env.DD_TRACE_DEBUG = 'true'
    process.env.DD_TRACE_LOG_LEVEL = 'error'

    reloadLoggerAndConfig()

    const config = getConfig()

    assertObjectContains(config, {
      debug: true,
      logger: undefined,
      logLevel: 'error',
    })
  })

  it('should initialize from environment variables with DD env vars taking precedence OTEL env vars', () => {
    process.env.DD_SERVICE = 'service'
    process.env.OTEL_SERVICE_NAME = 'otel_service'
    process.env.DD_TRACE_LOG_LEVEL = 'error'
    process.env.DD_TRACE_DEBUG = 'false'
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

    // required if we want to check updates to config.debug and config.logLevel which is fetched from logger
    reloadLoggerAndConfig()

    const config = getConfig()

    assertObjectContains(config, {
      debug: false,
      service: 'service',
      logLevel: 'error',
      sampleRate: 0.5,
      runtimeMetrics: {
        enabled: true,
      },
      tags: {
        foo: 'bar',
        baz: 'qux',
      },
      tracePropagationStyle: {
        inject: ['b3', 'tracecontext'],
        extract: ['b3', 'tracecontext'],
        otelPropagators: false,
      },
    })

    const indexFile = require('../../src/index')
    const proxy = require('../../src/proxy')
    assert.strictEqual(indexFile, proxy)
  })

  it('should initialize with OTEL environment variables when DD env vars are not set', () => {
    process.env.OTEL_SERVICE_NAME = 'otel_service'
    process.env.OTEL_LOG_LEVEL = 'debug'
    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.1'
    process.env.OTEL_TRACES_EXPORTER = 'none'
    process.env.OTEL_METRICS_EXPORTER = 'none'
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'foo=bar1,baz=qux1'
    process.env.OTEL_PROPAGATORS = 'b3,datadog'

    // required if we want to check updates to config.debug and config.logLevel which is fetched from logger
    reloadLoggerAndConfig()

    const config = getConfig()

    assertObjectContains(config, {
      debug: true,
      service: 'otel_service',
      logLevel: 'debug',
      sampleRate: 0.1,
      runtimeMetrics: {
        enabled: false,
      },
      tags: {
        foo: 'bar1',
        baz: 'qux1',
      },
      tracePropagationStyle: {
        inject: ['b3', 'datadog'],
        extract: ['b3', 'datadog'],
        otelPropagators: true,
      },
    })

    delete require.cache[require.resolve('../../src/index')]
    const indexFile = require('../../src/index')
    const noop = require('../../src/noop/proxy')
    assert.strictEqual(indexFile, noop)
  })

  it('should correctly map OTEL_RESOURCE_ATTRIBUTES', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      'deployment.environment=test1,service.name=test2,service.version=5,foo=bar1,baz=qux1'
    const config = getConfig()

    assertObjectContains(config, {
      env: 'test1',
      service: 'test2',
      version: '5',
      tags: {
        foo: 'bar1',
        baz: 'qux1',
      },
    })
  })

  it('should correctly map OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_on'
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.1'
    let config = getConfig()
    assert.strictEqual(config.sampleRate, 1.0)

    process.env.OTEL_TRACES_SAMPLER = 'always_off'
    config = getConfig()
    assert.strictEqual(config.sampleRate, 0.0)

    process.env.OTEL_TRACES_SAMPLER = 'traceidratio'
    config = getConfig()
    assert.strictEqual(config.sampleRate, 0.1)

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_on'
    config = getConfig()
    assert.strictEqual(config.sampleRate, 1.0)

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_off'
    config = getConfig()
    assert.strictEqual(config.sampleRate, 0.0)

    process.env.OTEL_TRACES_SAMPLER = 'parentbased_traceidratio'
    config = getConfig()
    assert.strictEqual(config.sampleRate, 0.1)
  })

  it('should initialize with the correct defaults', () => {
    const config = getConfig()

    assertObjectContains(config, {
      apmTracingEnabled: true,
      appKey: undefined,
      appsec: {
        apiSecurity: {
          enabled: true,
          sampleDelay: 30,
          endpointCollectionEnabled: true,
          endpointCollectionMessageLimit: 300,
          downstreamBodyAnalysisSampleRate: 0.5,
          maxDownstreamRequestBodyAnalysis: 1,
        },
        blockedTemplateHtml: undefined,
        blockedTemplateJson: undefined,
        blockedTemplateGraphql: undefined,
        enabled: undefined,
        eventTracking: {
          mode: 'identification',
        },
        extendedHeadersCollection: {
          enabled: false,
          maxHeaders: 50,
          redaction: true,
        },
        rules: undefined,
        rasp: {
          bodyCollection: false,
          enabled: true,
        },
        rateLimit: 100,
        sca: {
          enabled: undefined,
        },
        stackTrace: {
          enabled: true,
          maxDepth: 32,
          maxStackTraces: 2,
        },
        wafTimeout: 5e3,
      },
      clientIpEnabled: false,
      clientIpHeader: undefined,
      codeOriginForSpans: {
        enabled: true,
        experimental: {
          exit_spans: {
            enabled: false,
          },
        },
      },
      crashtracking: {
        enabled: true,
      },
      debug: false,
      dogstatsd: {
        hostname: '127.0.0.1',
        port: '8125',
      },
      dynamicInstrumentation: {
        enabled: false,
        probeFile: undefined,
        uploadIntervalSeconds: 1,
      },
      env: undefined,
      experimental: {
        aiguard: {
          enabled: false,
          endpoint: undefined,
          maxMessagesLength: 16,
          timeout: 10_000,
          maxContentSize: 512 * 1024,
        },
        exporter: '',
        enableGetRumData: false,
      },
      flushInterval: 2000,
      flushMinSpans: 1000,
      heapSnapshot: {
        count: 0,
        destination: '',
        interval: 3600,
      },
      iast: {
        enabled: false,
        redactionEnabled: true,
        redactionNamePattern: defaults['iast.redactionNamePattern'],
        redactionValuePattern: defaults['iast.redactionValuePattern'],
        telemetryVerbosity: 'INFORMATION',
        stackTrace: {
          enabled: true,
        },
      },
      injectForce: false,
      installSignature: {
        id: undefined,
        time: undefined,
        type: undefined,
      },
      instrumentationSource: 'manual',
      instrumentation_config_id: undefined,
      llmobs: {
        agentlessEnabled: undefined,
        enabled: false,
        mlApp: undefined,
      },
      logLevel: 'debug',
      middlewareTracingEnabled: true,
      plugins: true,
      protocolVersion: '0.4',
      tracing: true,
      tags: {
        service: 'node',
      },
      remoteConfig: {
        enabled: true,
        pollInterval: 5,
      },
      reportHostname: false,
      runtimeMetrics: {
        enabled: false,
        eventLoop: true,
        gc: true,
      },
      runtimeMetricsRuntimeId: false,
      sampleRate: undefined,
      scope: undefined,
      service: 'node',
      spanAttributeSchema: 'v0',
      spanComputePeerService: false,
      spanRemoveIntegrationFromService: false,
      traceEnabled: true,
      traceId128BitGenerationEnabled: true,
      traceId128BitLoggingEnabled: true,
      tracePropagationBehaviorExtract: 'continue',
    })
    assert.deepStrictEqual(config.dynamicInstrumentation?.redactedIdentifiers, [])
    assert.deepStrictEqual(config.dynamicInstrumentation?.redactionExcludedIdentifiers, [])
    assert.deepStrictEqual(config.grpc.client.error.statuses, GRPC_CLIENT_ERROR_STATUSES)
    assert.deepStrictEqual(config.grpc.server.error.statuses, GRPC_SERVER_ERROR_STATUSES)
    assert.deepStrictEqual(config.injectionEnabled, [])
    assert.deepStrictEqual(config.serviceMapping, {})
    assert.deepStrictEqual(config.tracePropagationStyle?.extract, ['datadog', 'tracecontext', 'baggage'])
    assert.deepStrictEqual(config.tracePropagationStyle?.inject, ['datadog', 'tracecontext', 'baggage'])
    assert.strictEqual(config.queryStringObfuscation?.length, 626)
    assert.strictEqual(config.appsec?.obfuscatorKeyRegex?.length, 190)
    assert.strictEqual(config.appsec?.obfuscatorValueRegex?.length, 578)

    sinon.assert.calledOnce(updateConfig)

    assertObjectContains(updateConfig.getCall(0).args[0].sort(comparator), [
      { name: 'apmTracingEnabled', value: true, origin: 'default' },
      { name: 'appsec.apiSecurity.enabled', value: true, origin: 'default' },
      { name: 'appsec.apiSecurity.sampleDelay', value: 30, origin: 'default' },
      { name: 'appsec.apiSecurity.endpointCollectionEnabled', value: true, origin: 'default' },
      { name: 'appsec.apiSecurity.endpointCollectionMessageLimit', value: 300, origin: 'default' },
      { name: 'appsec.apiSecurity.downstreamBodyAnalysisSampleRate', value: 0.5, origin: 'default' },
      { name: 'appsec.apiSecurity.maxDownstreamRequestBodyAnalysis', value: 1, origin: 'default' },
      { name: 'appsec.blockedTemplateHtml', value: undefined, origin: 'default' },
      { name: 'appsec.blockedTemplateJson', value: undefined, origin: 'default' },
      { name: 'appsec.enabled', value: undefined, origin: 'default' },
      { name: 'appsec.eventTracking.mode', value: 'identification', origin: 'default' },
      { name: 'appsec.extendedHeadersCollection.enabled', value: false, origin: 'default' },
      { name: 'appsec.extendedHeadersCollection.maxHeaders', value: 50, origin: 'default' },
      { name: 'appsec.extendedHeadersCollection.redaction', value: true, origin: 'default' },
      {
        name: 'appsec.obfuscatorKeyRegex',
        // eslint-disable-next-line @stylistic/max-len
        value: '(?i)pass|pw(?:or)?d|secret|(?:api|private|public|access)[_-]?key|token|consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization|jsessionid|phpsessid|asp\\.net[_-]sessionid|sid|jwt',
        origin: 'default',
      },
      {
        name: 'appsec.obfuscatorValueRegex',
        // eslint-disable-next-line @stylistic/max-len
        value: '(?i)(?:p(?:ass)?w(?:or)?d|pass(?:[_-]?phrase)?|secret(?:[_-]?key)?|(?:(?:api|private|public|access)[_-]?)key(?:[_-]?id)?|(?:(?:auth|access|id|refresh)[_-]?)?token|consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?|jsessionid|phpsessid|asp\\.net(?:[_-]|-)sessionid|sid|jwt)(?:\\s*=([^;&]+)|"\\s*:\\s*("[^"]+"|\\d+))|bearer\\s+([a-z0-9\\._\\-]+)|token\\s*:\\s*([a-z0-9]{13})|gh[opsu]_([0-9a-zA-Z]{36})|ey[I-L][\\w=-]+\\.(ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?)|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}([^\\-]+)[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*([a-z0-9\\/\\.+]{100,})',
        origin: 'default',
      },
      { name: 'appsec.rasp.bodyCollection', value: false, origin: 'default' },
      { name: 'appsec.rasp.enabled', value: true, origin: 'default' },
      { name: 'appsec.rateLimit', value: 100, origin: 'default' },
      { name: 'appsec.rules', value: undefined, origin: 'default' },
      { name: 'appsec.sca.enabled', value: undefined, origin: 'default' },
      { name: 'appsec.stackTrace.enabled', value: true, origin: 'default' },
      { name: 'appsec.stackTrace.maxDepth', value: 32, origin: 'default' },
      { name: 'appsec.stackTrace.maxStackTraces', value: 2, origin: 'default' },
      { name: 'appsec.wafTimeout', value: 5e3, origin: 'default' },
      { name: 'ciVisAgentlessLogSubmissionEnabled', value: false, origin: 'default' },
      { name: 'ciVisibilityTestSessionName', value: undefined, origin: 'default' },
      { name: 'clientIpEnabled', value: false, origin: 'default' },
      { name: 'clientIpHeader', value: undefined, origin: 'default' },
      { name: 'codeOriginForSpans.enabled', value: true, origin: 'default' },
      { name: 'codeOriginForSpans.experimental.exit_spans.enabled', value: false, origin: 'default' },
      { name: 'dbmPropagationMode', value: 'disabled', origin: 'default' },
      { name: 'dogstatsd.hostname', value: '127.0.0.1', origin: 'calculated' },
      { name: 'dogstatsd.port', value: '8125', origin: 'default' },
      { name: 'dsmEnabled', value: false, origin: 'default' },
      { name: 'dynamicInstrumentation.enabled', value: false, origin: 'default' },
      { name: 'dynamicInstrumentation.probeFile', value: undefined, origin: 'default' },
      { name: 'dynamicInstrumentation.redactedIdentifiers', value: [], origin: 'default' },
      { name: 'dynamicInstrumentation.redactionExcludedIdentifiers', value: [], origin: 'default' },
      { name: 'dynamicInstrumentation.uploadIntervalSeconds', value: 1, origin: 'default' },
      { name: 'env', value: undefined, origin: 'default' },
      { name: 'experimental.aiguard.enabled', value: false, origin: 'default' },
      { name: 'experimental.aiguard.endpoint', value: undefined, origin: 'default' },
      { name: 'experimental.aiguard.maxContentSize', value: 512 * 1024, origin: 'default' },
      { name: 'experimental.aiguard.maxMessagesLength', value: 16, origin: 'default' },
      { name: 'experimental.aiguard.timeout', value: 10_000, origin: 'default' },
      { name: 'experimental.enableGetRumData', value: false, origin: 'default' },
      { name: 'experimental.exporter', value: '', origin: 'default' },
      { name: 'flakyTestRetriesCount', value: 5, origin: 'default' },
      { name: 'flushInterval', value: 2000, origin: 'default' },
      { name: 'flushMinSpans', value: 1000, origin: 'default' },
      { name: 'gitMetadataEnabled', value: true, origin: 'default' },
      { name: 'headerTags', value: [], origin: 'default' },
      { name: 'hostname', value: '127.0.0.1', origin: 'default' },
      { name: 'iast.dbRowsToTaint', value: 1, origin: 'default' },
      { name: 'iast.deduplicationEnabled', value: true, origin: 'default' },
      { name: 'iast.enabled', value: false, origin: 'default' },
      { name: 'iast.maxConcurrentRequests', value: 2, origin: 'default' },
      { name: 'iast.maxContextOperations', value: 2, origin: 'default' },
      { name: 'iast.redactionEnabled', value: true, origin: 'default' },
      { name: 'iast.redactionNamePattern', value: defaults['iast.redactionNamePattern'], origin: 'default' },
      { name: 'iast.redactionValuePattern', value: defaults['iast.redactionValuePattern'], origin: 'default' },
      { name: 'iast.requestSampling', value: 30, origin: 'default' },
      { name: 'iast.securityControlsConfiguration', value: undefined, origin: 'default' },
      { name: 'iast.stackTrace.enabled', value: true, origin: 'default' },
      { name: 'iast.telemetryVerbosity', value: 'INFORMATION', origin: 'default' },
      { name: 'injectForce', value: false, origin: 'default' },
      { name: 'injectionEnabled', value: [], origin: 'default' },
      { name: 'instrumentationSource', value: 'manual', origin: 'default' },
      { name: 'isCiVisibility', value: false, origin: 'default' },
      { name: 'isEarlyFlakeDetectionEnabled', value: true, origin: 'default' },
      { name: 'isFlakyTestRetriesEnabled', value: true, origin: 'default' },
      { name: 'isGCPFunction', value: false, origin: 'env_var' },
      { name: 'isGitUploadEnabled', value: false, origin: 'default' },
      { name: 'isIntelligentTestRunnerEnabled', value: false, origin: 'default' },
      { name: 'isManualApiEnabled', value: false, origin: 'default' },
      { name: 'langchain.spanCharLimit', value: 128, origin: 'default' },
      { name: 'langchain.spanPromptCompletionSampleRate', value: 1.0, origin: 'default' },
      { name: 'llmobs.agentlessEnabled', value: undefined, origin: 'default' },
      { name: 'llmobs.mlApp', value: undefined, origin: 'default' },
      { name: 'isTestDynamicInstrumentationEnabled', value: true, origin: 'default' },
      { name: 'logInjection', value: true, origin: 'default' },
      { name: 'lookup', value: undefined, origin: 'default' },
      { name: 'middlewareTracingEnabled', value: true, origin: 'default' },
      { name: 'openai.spanCharLimit', value: 128, origin: 'default' },
      { name: 'openAiLogsEnabled', value: false, origin: 'default' },
      { name: 'peerServiceMapping', value: {}, origin: 'default' },
      { name: 'plugins', value: true, origin: 'default' },
      { name: 'port', value: '8126', origin: 'default' },
      { name: 'profiling.enabled', value: false, origin: 'default' },
      { name: 'profiling.exporters', value: 'agent', origin: 'default' },
      { name: 'profiling.sourceMap', value: true, origin: 'default' },
      { name: 'protocolVersion', value: '0.4', origin: 'default' },
      {
        name: 'queryStringObfuscation',
        value: config.queryStringObfuscation,
        origin: 'default',
      },
      { name: 'remoteConfig.enabled', value: true, origin: 'default' },
      { name: 'remoteConfig.pollInterval', value: 5, origin: 'default' },
      { name: 'reportHostname', value: false, origin: 'default' },
      { name: 'runtimeMetrics.enabled', value: false, origin: 'default' },
      { name: 'runtimeMetricsRuntimeId', value: false, origin: 'default' },
      { name: 'sampleRate', value: undefined, origin: 'default' },
      { name: 'sampler.rateLimit', value: 100, origin: 'default' },
      { name: 'sampler.rules', value: [], origin: 'default' },
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
      { name: 'telemetry.enabled', value: true, origin: 'default' },
      { name: 'telemetry.heartbeatInterval', value: 60, origin: 'default' },
      { name: 'telemetry.logCollection', value: true, origin: 'default' },
      { name: 'telemetry.metrics', value: true, origin: 'default' },
      { name: 'traceEnabled', value: true, origin: 'default' },
      { name: 'traceId128BitGenerationEnabled', value: true, origin: 'default' },
      { name: 'traceId128BitLoggingEnabled', value: true, origin: 'default' },
      { name: 'tracing', value: true, origin: 'default' },
      { name: 'url', value: '', origin: 'default' },
      { name: 'version', value: '', origin: 'default' },
      { name: 'vertexai.spanCharLimit', value: 128, origin: 'default' },
      { name: 'vertexai.spanPromptCompletionSampleRate', value: 1.0, origin: 'default' },
    ].sort(comparator))
  })

  it('should support logging', () => {
    const config = getConfig({
      logger: {},
      debug: true,
    })

    sinon.assert.calledWith(log.use, config.logger)
    sinon.assert.calledWith(log.toggle, config.debug)
  })

  it('should not warn on undefined DD_TRACE_SPAN_ATTRIBUTE_SCHEMA', () => {
    const config = getConfig({
      logger: {},
      debug: true,
    })
    sinon.assert.notCalled(log.warn)
    assert.strictEqual(config.spanAttributeSchema, 'v0')
  })

  it('should initialize from the default service', () => {
    pkg.name = 'test'
    reloadLoggerAndConfig()

    const config = getConfig()

    assert.strictEqual(config.service, 'test')
    assert.strictEqual(config.tags?.service, 'test')
  })

  it('should initialize from the default version', () => {
    pkg.version = '1.2.3'
    reloadLoggerAndConfig()

    const config = getConfig()

    assert.strictEqual(config.version, '1.2.3')
    assert.strictEqual(config.tags?.version, '1.2.3')
  })

  it('should initialize from environment variables', () => {
    process.env.DD_AI_GUARD_ENABLED = 'true'
    process.env.DD_AI_GUARD_ENDPOINT = 'https://dd.datad0g.com/api/unstable/ai-guard'
    process.env.DD_AI_GUARD_MAX_CONTENT_SIZE = String(1024 * 1024)
    process.env.DD_AI_GUARD_MAX_MESSAGES_LENGTH = '32'
    process.env.DD_AI_GUARD_TIMEOUT = '2000'
    process.env.DD_API_SECURITY_ENABLED = 'true'
    process.env.DD_API_SECURITY_SAMPLE_DELAY = '25'
    process.env.DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED = 'false'
    process.env.DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT = '500'
    process.env.DD_API_SECURITY_DOWNSTREAM_BODY_ANALYSIS_SAMPLE_RATE = '0.75'
    process.env.DD_API_SECURITY_MAX_DOWNSTREAM_REQUEST_BODY_ANALYSIS = '2'
    process.env.DD_APM_TRACING_ENABLED = 'false'
    process.env.DD_APP_KEY = 'myAppKey'
    process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = 'extended'
    process.env.DD_APPSEC_COLLECT_ALL_HEADERS = 'true'
    process.env.DD_APPSEC_ENABLED = 'true'
    process.env.DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_GRAPHQL_PATH
    process.env.DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED = 'false'
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = BLOCKED_TEMPLATE_HTML_PATH
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_JSON_PATH
    process.env.DD_APPSEC_MAX_COLLECTED_HEADERS = '42'
    process.env.DD_APPSEC_MAX_STACK_TRACE_DEPTH = '42'
    process.env.DD_APPSEC_MAX_STACK_TRACES = '5'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = '.*'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = '.*'
    process.env.DD_APPSEC_RASP_COLLECT_REQUEST_BODY = 'true'
    process.env.DD_APPSEC_RASP_ENABLED = 'false'
    process.env.DD_APPSEC_RULES = RULES_JSON_PATH
    process.env.DD_APPSEC_SCA_ENABLED = 'true'
    process.env.DD_APPSEC_STACK_TRACE_ENABLED = 'false'
    process.env.DD_APPSEC_TRACE_RATE_LIMIT = '42'
    process.env.DD_APPSEC_WAF_TIMEOUT = '42'
    process.env.DD_CODE_ORIGIN_FOR_SPANS_ENABLED = 'false'
    process.env.DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED = 'true'
    process.env.DD_CRASHTRACKING_ENABLED = 'false'
    process.env.DD_DOGSTATSD_HOSTNAME = 'dsd-agent'
    process.env.DD_DOGSTATSD_PORT = '5218'
    process.env.DD_DYNAMIC_INSTRUMENTATION_ENABLED = 'true'
    process.env.DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE = 'probes.json'
    process.env.DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS = 'foo,bar'
    process.env.DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS = 'a,b,c'
    process.env.DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS = '0.1'
    process.env.DD_ENV = 'test'
    process.env.DD_GRPC_CLIENT_ERROR_STATUSES = '3,13,400-403'
    process.env.DD_GRPC_SERVER_ERROR_STATUSES = '3,13,400-403'
    process.env.DD_HEAP_SNAPSHOT_COUNT = '1'
    process.env.DD_HEAP_SNAPSHOT_DESTINATION = '/tmp'
    process.env.DD_HEAP_SNAPSHOT_INTERVAL = '1800'
    process.env.DD_IAST_DB_ROWS_TO_TAINT = '2'
    process.env.DD_IAST_DEDUPLICATION_ENABLED = 'false'
    process.env.DD_IAST_ENABLED = 'true'
    process.env.DD_IAST_MAX_CONCURRENT_REQUESTS = '3'
    process.env.DD_IAST_MAX_CONTEXT_OPERATIONS = '4'
    process.env.DD_IAST_REDACTION_ENABLED = 'false'
    process.env.DD_IAST_REDACTION_NAME_PATTERN = 'REDACTION_NAME_PATTERN'
    process.env.DD_IAST_REDACTION_VALUE_PATTERN = 'REDACTION_VALUE_PATTERN'
    process.env.DD_IAST_REQUEST_SAMPLING = '40'
    process.env.DD_IAST_SECURITY_CONTROLS_CONFIGURATION = 'SANITIZER:CODE_INJECTION:sanitizer.js:method'
    process.env.DD_IAST_STACK_TRACE_ENABLED = 'false'
    process.env.DD_IAST_TELEMETRY_VERBOSITY = 'DEBUG'
    process.env.DD_INJECT_FORCE = 'false'
    process.env.DD_INJECTION_ENABLED = 'tracer'
    process.env.DD_INSTRUMENTATION_CONFIG_ID = 'abcdef123'
    process.env.DD_INSTRUMENTATION_INSTALL_ID = '68e75c48-57ca-4a12-adfc-575c4b05fcbe'
    process.env.DD_INSTRUMENTATION_INSTALL_TIME = '1703188212'
    process.env.DD_INSTRUMENTATION_INSTALL_TYPE = 'k8s_single_step'
    process.env.DD_LANGCHAIN_SPAN_CHAR_LIMIT = '50'
    process.env.DD_LANGCHAIN_SPAN_PROMPT_COMPLETION_SAMPLE_RATE = '0.5'
    process.env.DD_LLMOBS_AGENTLESS_ENABLED = 'true'
    process.env.DD_LLMOBS_ML_APP = 'myMlApp'
    process.env.DD_PROFILING_ENABLED = 'true'
    process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = '42'
    process.env.DD_REMOTE_CONFIGURATION_ENABLED = 'false'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.DD_RUNTIME_METRICS_EVENT_LOOP_ENABLED = 'false'
    process.env.DD_RUNTIME_METRICS_GC_ENABLED = 'false'
    process.env.DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED = 'true'
    process.env.DD_SERVICE = 'service'
    process.env.DD_SERVICE_MAPPING = 'a:aa, b:bb'
    process.env.DD_SPAN_SAMPLING_RULES = `[
      {"service":"mysql","name":"mysql.query","sample_rate":0.0,"max_per_second":1},
      {"service":"mysql","sample_rate":0.5},
      {"service":"mysql","sample_rate":1.0},
      {"sample_rate":0.1}
    ]`
    process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = 'true'
    process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = 'true'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_TRACE_AGENT_PROTOCOL_VERSION = '0.5'
    process.env.DD_TRACE_CLIENT_IP_ENABLED = 'true'
    process.env.DD_TRACE_CLIENT_IP_HEADER = 'x-true-client-ip'
    process.env.DD_TRACE_DEBUG = 'true'
    process.env.DD_TRACE_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'log'
    process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_INTERNAL_ERRORS_ENABLED = 'true'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:bar,baz:qux'
    process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED = 'false'
    process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = '.*'
    process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'true'
    process.env.DD_TRACE_PEER_SERVICE_MAPPING = 'c:cc, d:dd'
    process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'restart'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'b3,tracecontext'
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'b3,tracecontext'
    process.env.DD_TRACE_RATE_LIMIT = '-1'
    process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = 'true'
    process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
    process.env.DD_TRACE_SAMPLE_RATE = '0.5'
    process.env.DD_TRACE_SAMPLING_RULES = `[
      {"service":"usersvc","name":"healthcheck","sample_rate":0.0 },
      {"service":"usersvc","sample_rate":0.5},
      {"service":"authsvc","sample_rate":1.0},
      {"sample_rate":0.1}
    ]`
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v1'
    process.env.DD_TRACING_ENABLED = 'false'
    process.env.DD_VERSION = '1.0.0'
    process.env.DD_VERTEXAI_SPAN_CHAR_LIMIT = '50'
    process.env.DD_VERTEXAI_SPAN_PROMPT_COMPLETION_SAMPLE_RATE = '0.5'

    // required if we want to check updates to config.debug and config.logLevel which is fetched from logger
    reloadLoggerAndConfig()

    const config = getConfig()

    assertObjectContains(config, {
      apmTracingEnabled: false,
      appKey: 'myAppKey',
      appsec: {
        apiSecurity: {
          enabled: true,
          sampleDelay: 25,
          endpointCollectionEnabled: false,
          endpointCollectionMessageLimit: 500,
          downstreamBodyAnalysisSampleRate: 0.75,
          maxDownstreamRequestBodyAnalysis: 2,
        },
        blockedTemplateGraphql: BLOCKED_TEMPLATE_GRAPHQL,
        blockedTemplateHtml: BLOCKED_TEMPLATE_HTML,
        blockedTemplateJson: BLOCKED_TEMPLATE_JSON,
        enabled: true,
        eventTracking: {
          mode: 'extended',
        },
        extendedHeadersCollection: {
          enabled: true,
          maxHeaders: 42,
          redaction: false,
        },
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        rasp: {
          bodyCollection: true,
          enabled: false,
        },
        rateLimit: 42,
        rules: RULES_JSON_PATH,
        sca: {
          enabled: true,
        },
        stackTrace: {
          enabled: false,
          maxDepth: 42,
          maxStackTraces: 5,
        },
        wafTimeout: 42,
      },
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      codeOriginForSpans: {
        enabled: false,
        experimental: {
          exit_spans: {
            enabled: true,
          },
        },
      },
      crashtracking: {
        enabled: false,
      },
      debug: true,
      dogstatsd: {
        hostname: 'dsd-agent',
        port: '5218',
      },
      dynamicInstrumentation: {
        enabled: true,
        probeFile: 'probes.json',
        redactedIdentifiers: ['foo', 'bar'],
        redactionExcludedIdentifiers: ['a', 'b', 'c'],
        uploadIntervalSeconds: 0.1,
      },
      env: 'test',
      experimental: {
        aiguard: {
          enabled: true,
          endpoint: 'https://dd.datad0g.com/api/unstable/ai-guard',
          maxContentSize: 1024 * 1024,
          maxMessagesLength: 32,
          timeout: 2000,
        },
        enableGetRumData: true,
        exporter: 'log',
      },
      hostname: 'agent',
      heapSnapshot: {
        count: 1,
        destination: '/tmp',
        interval: 1800,
      },
      iast: {
        dbRowsToTaint: 2,
        deduplicationEnabled: false,
        enabled: true,
        maxConcurrentRequests: 3,
        maxContextOperations: 4,
        redactionEnabled: false,
        redactionNamePattern: 'REDACTION_NAME_PATTERN',
        redactionValuePattern: 'REDACTION_VALUE_PATTERN',
        requestSampling: 40,
        securityControlsConfiguration: 'SANITIZER:CODE_INJECTION:sanitizer.js:method',
        stackTrace: {
          enabled: false,
        },
        telemetryVerbosity: 'DEBUG',
      },
      instrumentation_config_id: 'abcdef123',
      llmobs: {
        agentlessEnabled: true,
        mlApp: 'myMlApp',
      },
      middlewareTracingEnabled: false,
      protocolVersion: '0.5',
      queryStringObfuscation: '.*',
      remoteConfig: {
        enabled: false,
        pollInterval: 42,
      },
      reportHostname: true,
      runtimeMetrics: {
        enabled: true,
        eventLoop: false,
        gc: false,
      },
      runtimeMetricsRuntimeId: true,
      sampleRate: 0.5,
      service: 'service',
      spanAttributeSchema: 'v1',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
      tags: {
        foo: 'bar',
        baz: 'qux',
        service: 'service',
        version: '1.0.0',
        env: 'test',
      },
      traceEnabled: true,
      traceId128BitGenerationEnabled: true,
      traceId128BitLoggingEnabled: true,
      tracePropagationBehaviorExtract: 'restart',
      tracing: false,
      version: '1.0.0',
    })
    assert.deepStrictEqual(config.grpc.client.error.statuses, [3, 13, 400, 401, 402, 403])
    assert.deepStrictEqual(config.grpc.server.error.statuses, [3, 13, 400, 401, 402, 403])
    assert.deepStrictEqual(
      config.installSignature,
      { id: '68e75c48-57ca-4a12-adfc-575c4b05fcbe', type: 'k8s_single_step', time: '1703188212' }
    )
    assert.deepStrictEqual(config.peerServiceMapping, { c: 'cc', d: 'dd' })
    assert.deepStrictEqual(config.sampler, {
      sampleRate: 0.5,
      rateLimit: '-1',
      rules: [
        { service: 'usersvc', name: 'healthcheck', sampleRate: 0.0 },
        { service: 'usersvc', sampleRate: 0.5 },
        { service: 'authsvc', sampleRate: 1.0 },
        { sampleRate: 0.1 },
      ],
      spanSamplingRules: [
        { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
        { service: 'mysql', sampleRate: 0.5 },
        { service: 'mysql', sampleRate: 1.0 },
        { sampleRate: 0.1 },
      ],
    })
    assert.deepStrictEqual(config.serviceMapping, { a: 'aa', b: 'bb' })
    assert.deepStrictEqual(config.tracePropagationStyle?.extract, ['b3', 'tracecontext'])
    assert.deepStrictEqual(config.tracePropagationStyle?.inject, ['b3', 'tracecontext'])

    sinon.assert.calledOnce(updateConfig)

    assertObjectContains(updateConfig.getCall(0).args[0].sort(comparator), [
      { name: 'apmTracingEnabled', value: false, origin: 'env_var' },
      { name: 'appsec.apiSecurity.enabled', value: true, origin: 'env_var' },
      { name: 'appsec.apiSecurity.sampleDelay', value: 25, origin: 'env_var' },
      { name: 'appsec.apiSecurity.endpointCollectionEnabled', value: false, origin: 'env_var' },
      { name: 'appsec.apiSecurity.endpointCollectionMessageLimit', value: 500, origin: 'env_var' },
      { name: 'appsec.apiSecurity.downstreamBodyAnalysisSampleRate', value: 0.75, origin: 'env_var' },
      { name: 'appsec.apiSecurity.maxDownstreamRequestBodyAnalysis', value: 2, origin: 'env_var' },
      { name: 'appsec.blockedTemplateHtml', value: BLOCKED_TEMPLATE_HTML_PATH, origin: 'env_var' },
      { name: 'appsec.blockedTemplateJson', value: BLOCKED_TEMPLATE_JSON_PATH, origin: 'env_var' },
      { name: 'appsec.enabled', value: true, origin: 'env_var' },
      { name: 'appsec.eventTracking.mode', value: 'extended', origin: 'env_var' },
      { name: 'appsec.extendedHeadersCollection.enabled', value: true, origin: 'env_var' },
      { name: 'appsec.extendedHeadersCollection.maxHeaders', value: '42', origin: 'env_var' },
      { name: 'appsec.extendedHeadersCollection.redaction', value: false, origin: 'env_var' },
      { name: 'appsec.obfuscatorKeyRegex', value: '.*', origin: 'env_var' },
      { name: 'appsec.obfuscatorValueRegex', value: '.*', origin: 'env_var' },
      { name: 'appsec.rasp.bodyCollection', value: true, origin: 'env_var' },
      { name: 'appsec.rasp.enabled', value: false, origin: 'env_var' },
      { name: 'appsec.rateLimit', value: '42', origin: 'env_var' },
      { name: 'appsec.rules', value: RULES_JSON_PATH, origin: 'env_var' },
      { name: 'appsec.sca.enabled', value: true, origin: 'env_var' },
      { name: 'appsec.stackTrace.enabled', value: false, origin: 'env_var' },
      { name: 'appsec.stackTrace.maxDepth', value: '42', origin: 'env_var' },
      { name: 'appsec.stackTrace.maxStackTraces', value: '5', origin: 'env_var' },
      { name: 'appsec.wafTimeout', value: '42', origin: 'env_var' },
      { name: 'clientIpEnabled', value: true, origin: 'env_var' },
      { name: 'clientIpHeader', value: 'x-true-client-ip', origin: 'env_var' },
      { name: 'codeOriginForSpans.enabled', value: false, origin: 'env_var' },
      { name: 'codeOriginForSpans.experimental.exit_spans.enabled', value: true, origin: 'env_var' },
      { name: 'crashtracking.enabled', value: false, origin: 'env_var' },
      { name: 'dogstatsd.hostname', value: 'dsd-agent', origin: 'env_var' },
      { name: 'dogstatsd.port', value: '5218', origin: 'env_var' },
      { name: 'dynamicInstrumentation.enabled', value: true, origin: 'env_var' },
      { name: 'dynamicInstrumentation.probeFile', value: 'probes.json', origin: 'env_var' },
      { name: 'dynamicInstrumentation.redactedIdentifiers', value: ['foo', 'bar'], origin: 'env_var' },
      { name: 'dynamicInstrumentation.redactionExcludedIdentifiers', value: ['a', 'b', 'c'], origin: 'env_var' },
      { name: 'dynamicInstrumentation.uploadIntervalSeconds', value: 0.1, origin: 'env_var' },
      { name: 'env', value: 'test', origin: 'env_var' },
      { name: 'experimental.aiguard.enabled', value: false, origin: 'default' },
      { name: 'experimental.aiguard.endpoint', value: undefined, origin: 'default' },
      { name: 'experimental.aiguard.maxContentSize', value: 512 * 1024, origin: 'default' },
      { name: 'experimental.aiguard.maxMessagesLength', value: 16, origin: 'default' },
      { name: 'experimental.aiguard.timeout', value: 10_000, origin: 'default' },
      { name: 'experimental.enableGetRumData', value: true, origin: 'env_var' },
      { name: 'experimental.exporter', value: 'log', origin: 'env_var' },
      { name: 'hostname', value: 'agent', origin: 'env_var' },
      { name: 'iast.dbRowsToTaint', value: 2, origin: 'env_var' },
      { name: 'iast.deduplicationEnabled', value: false, origin: 'env_var' },
      { name: 'iast.enabled', value: true, origin: 'env_var' },
      { name: 'iast.maxConcurrentRequests', value: '3', origin: 'env_var' },
      { name: 'iast.maxContextOperations', value: '4', origin: 'env_var' },
      { name: 'iast.redactionEnabled', value: false, origin: 'env_var' },
      { name: 'iast.redactionNamePattern', value: 'REDACTION_NAME_PATTERN', origin: 'env_var' },
      { name: 'iast.redactionValuePattern', value: 'REDACTION_VALUE_PATTERN', origin: 'env_var' },
      { name: 'iast.requestSampling', value: '40', origin: 'env_var' },
      {
        name: 'iast.securityControlsConfiguration',
        value: 'SANITIZER:CODE_INJECTION:sanitizer.js:method',
        origin: 'env_var',
      },
      { name: 'iast.stackTrace.enabled', value: false, origin: 'env_var' },
      { name: 'iast.telemetryVerbosity', value: 'DEBUG', origin: 'env_var' },
      { name: 'injectForce', value: false, origin: 'env_var' },
      { name: 'injectionEnabled', value: ['tracer'], origin: 'env_var' },
      { name: 'instrumentation_config_id', value: 'abcdef123', origin: 'env_var' },
      { name: 'instrumentationSource', value: 'ssi', origin: 'env_var' },
      { name: 'isGCPFunction', value: false, origin: 'env_var' },
      { name: 'langchain.spanCharLimit', value: 50, origin: 'env_var' },
      { name: 'langchain.spanPromptCompletionSampleRate', value: 0.5, origin: 'env_var' },
      { name: 'llmobs.agentlessEnabled', value: true, origin: 'env_var' },
      { name: 'llmobs.mlApp', value: 'myMlApp', origin: 'env_var' },
      { name: 'middlewareTracingEnabled', value: false, origin: 'env_var' },
      { name: 'peerServiceMapping', value: process.env.DD_TRACE_PEER_SERVICE_MAPPING, origin: 'env_var' },
      { name: 'port', value: '6218', origin: 'env_var' },
      { name: 'profiling.enabled', value: 'true', origin: 'env_var' },
      { name: 'protocolVersion', value: '0.5', origin: 'env_var' },
      { name: 'queryStringObfuscation', value: '.*', origin: 'env_var' },
      { name: 'remoteConfig.enabled', value: false, origin: 'env_var' },
      { name: 'remoteConfig.pollInterval', value: '42', origin: 'env_var' },
      { name: 'reportHostname', value: true, origin: 'env_var' },
      { name: 'runtimeMetrics.enabled', value: true, origin: 'env_var' },
      { name: 'runtimeMetricsRuntimeId', value: true, origin: 'env_var' },
      { name: 'sampler.rateLimit', value: '-1', origin: 'env_var' },
      { name: 'sampler.rules', value: process.env.DD_TRACE_SAMPLING_RULES, origin: 'env_var' },
      { name: 'sampleRate', value: 0.5, origin: 'env_var' },
      { name: 'service', value: 'service', origin: 'env_var' },
      { name: 'spanAttributeSchema', value: 'v1', origin: 'env_var' },
      { name: 'spanRemoveIntegrationFromService', value: true, origin: 'env_var' },
      { name: 'traceId128BitGenerationEnabled', value: true, origin: 'env_var' },
      { name: 'traceId128BitLoggingEnabled', value: true, origin: 'env_var' },
      { name: 'tracing', value: false, origin: 'env_var' },
      { name: 'version', value: '1.0.0', origin: 'env_var' },
      { name: 'vertexai.spanCharLimit', value: 50, origin: 'env_var' },
      { name: 'vertexai.spanPromptCompletionSampleRate', value: 0.5, origin: 'env_var' },
    ].sort(comparator))
  })

  it('should ignore empty strings', () => {
    process.env.DD_TAGS = 'service:,env:,version:'

    let config = getConfig()

    assertObjectContains(config, {
      service: 'node',
      env: undefined,
      version: '',
    })

    process.env.DD_TAGS = 'service: env: version:'

    config = getConfig()

    assertObjectContains(config, {
      service: 'node',
      env: undefined,
      version: '',
    })
  })

  it('should support space separated tags when experimental mode enabled', () => {
    process.env.DD_TAGS = 'key1:value1 key2:value2'

    let config = getConfig()

    assertObjectContains(config.tags, { key1: 'value1', key2: 'value2' })

    process.env.DD_TAGS = 'env:test aKey:aVal bKey:bVal cKey:'

    config = getConfig()

    assertObjectContains(config.tags, {
      env: 'test',
      aKey: 'aVal',
      bKey: 'bVal',
      cKey: '',
    })

    process.env.DD_TAGS = 'env:test,aKey:aVal bKey:bVal cKey:'

    config = getConfig()

    assertObjectContains(config.tags, {
      env: 'test',
      aKey: 'aVal bKey:bVal cKey:',
    })

    process.env.DD_TAGS = 'a:b:c:d'

    config = getConfig()

    assert.strictEqual(config.tags?.a, 'b:c:d')

    process.env.DD_TAGS = 'a,1'

    config = getConfig()

    assertObjectContains(config.tags, {
      a: '',
      1: '',
    })
  })

  it('should read case-insensitive booleans from environment variables', () => {
    process.env.DD_TRACING_ENABLED = 'False'
    process.env.DD_TRACE_PROPAGATION_EXTRACT_FIRST = 'TRUE'
    process.env.DD_RUNTIME_METRICS_ENABLED = '0'

    const config = getConfig()

    assertObjectContains(config, {
      tracing: false,
      tracePropagationExtractFirst: true,
      runtimeMetrics: {
        enabled: false,
      },
    })
  })

  it('should initialize from environment variables with url taking precedence', () => {
    process.env.DD_TRACE_AGENT_URL = 'https://agent2:7777'
    process.env.DD_SITE = 'datadoghq.eu'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_TRACING_ENABLED = 'false'
    process.env.DD_SERVICE = 'service'
    process.env.DD_ENV = 'test'

    const config = getConfig()

    assert.strictEqual(config.url.toString(), 'https://agent2:7777/')

    assertObjectContains(config, {
      tracing: false,
      dogstatsd: {
        hostname: 'agent',
      },
      site: 'datadoghq.eu',
      service: 'service',
      env: 'test',
    })
  })

  it('should initialize from environment variables with inject/extract taking precedence', () => {
    process.env.DD_TRACE_PROPAGATION_STYLE = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'tracecontext'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'tracecontext'

    const config = getConfig()

    assert.deepStrictEqual(config.tracePropagationStyle?.inject, ['tracecontext'])
    assert.deepStrictEqual(config.tracePropagationStyle?.extract, ['tracecontext'])
  })

  it('should enable crash tracking for SSI by default', () => {
    process.env.DD_INJECTION_ENABLED = 'tracer'

    const config = getConfig()

    assert.deepStrictEqual(config.crashtracking?.enabled, true)
  })

  it('should disable crash tracking for SSI when configured', () => {
    process.env.DD_CRASHTRACKING_ENABLED = 'false'
    process.env.DD_INJECTION_ENABLED = 'tracer'

    const config = getConfig()

    assert.deepStrictEqual(config.crashtracking?.enabled, false)
  })

  it('should prioritize DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE over DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING', () => {
    process.env.DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE = 'anonymous'
    process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = 'extended'

    const config = getConfig()

    assert.strictEqual(config.appsec?.eventTracking?.mode, 'anonymous')
  })

  it('should initialize from the options', () => {
    const logger = {}
    const tags = {
      foo: 'bar',
    }
    const logLevel = 'error'
    const samplingRules = [
      { service: 'usersvc', name: 'healthcheck', sampleRate: 0.0 },
      { service: 'usersvc', sampleRate: 0.5 },
      { service: 'authsvc', sampleRate: 1.0 },
      { sampleRate: 0.1 },
    ]
    const config = getConfig({
      appsec: false,
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      codeOriginForSpans: {
        enabled: false,
        experimental: {
          exit_spans: {
            enabled: true,
          },
        },
      },
      debug: true,
      dogstatsd: {
        hostname: 'agent-dsd',
        port: 5218,
      },
      dynamicInstrumentation: {
        enabled: true,
        probeFile: 'probes.json',
        redactedIdentifiers: ['foo', 'bar'],
        redactionExcludedIdentifiers: ['a', 'b', 'c'],
        uploadIntervalSeconds: 0.1,
      },
      enabled: false,
      env: 'test',
      experimental: {
        b3: true,
        aiguard: {
          enabled: true,
          endpoint: 'https://dd.datad0g.com/api/unstable/ai-guard',
          maxContentSize: 1024 * 1024,
          maxMessagesLength: 32,
          timeout: 2000,
        },
        exporter: 'log',
        enableGetRumData: true,
        iast: {
          dbRowsToTaint: 2,
          deduplicationEnabled: false,
          enabled: true,
          maxConcurrentRequests: 4,
          maxContextOperations: 5,
          redactionEnabled: false,
          redactionNamePattern: 'REDACTION_NAME_PATTERN',
          redactionValuePattern: 'REDACTION_VALUE_PATTERN',
          requestSampling: 50,
          securityControlsConfiguration: 'SANITIZER:CODE_INJECTION:sanitizer.js:method',
          stackTrace: {
            enabled: false,
          },
          telemetryVerbosity: 'DEBUG',
        },
        traceparent: true,
      },
      flushInterval: 5000,
      flushMinSpans: 500,
      hostname: 'agent',
      llmobs: {
        mlApp: 'myMlApp',
        agentlessEnabled: true,
        apiKey: 'myApiKey',
      },
      logger,
      logLevel,
      middlewareTracingEnabled: false,
      peerServiceMapping: {
        d: 'dd',
      },
      plugins: false,
      port: 6218,
      protocolVersion: '0.5',
      rateLimit: 1000,
      remoteConfig: {
        pollInterval: 42,
      },
      reportHostname: true,
      runtimeMetrics: {
        enabled: true,
        eventLoop: false,
        gc: false,
      },
      runtimeMetricsRuntimeId: true,
      sampleRate: 0.5,
      samplingRules,
      service: 'service',
      serviceMapping: {
        a: 'aa',
        b: 'bb',
      },
      site: 'datadoghq.eu',
      spanAttributeSchema: 'v1',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
      spanSamplingRules: [
        { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
        { service: 'mysql', sampleRate: 0.5 },
        { service: 'mysql', sampleRate: 1.0 },
        { sampleRate: 0.1 },
      ],
      tags,
      traceId128BitGenerationEnabled: true,
      traceId128BitLoggingEnabled: true,
      tracePropagationStyle: {
        inject: ['datadog'],
        extract: ['datadog'],
      },
      version: '0.1.0',
    })

    assertObjectContains(config, {
      appsec: {
        enabled: false,
      },
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      codeOriginForSpans: {
        enabled: false,
        experimental: {
          exit_spans: {
            enabled: true,
          },
        },
      },
      dogstatsd: {
        hostname: 'agent-dsd',
        port: '5218',
      },
      dynamicInstrumentation: {
        enabled: true,
        probeFile: 'probes.json',
      },
    })
    assert.deepStrictEqual(config.dynamicInstrumentation?.redactedIdentifiers, ['foo', 'bar'])
    assert.deepStrictEqual(config.dynamicInstrumentation?.redactionExcludedIdentifiers, ['a', 'b', 'c'])
    assertObjectContains(config, {
      dynamicInstrumentation: {
        uploadIntervalSeconds: 0.1,
      },
      env: 'test',
      experimental: {
        aiguard: {
          enabled: true,
          endpoint: 'https://dd.datad0g.com/api/unstable/ai-guard',
        },
      },
    })
    assert.strictEqual(config.experimental?.aiguard?.maxContentSize, 1024 * 1024)
    assertObjectContains(config, {
      experimental: {
        aiguard: {
          maxMessagesLength: 32,
          timeout: 2000,
        },
        enableGetRumData: true,
        exporter: 'log',
      },
      flushInterval: 5000,
      flushMinSpans: 500,
      hostname: 'agent',
      iast: {
        dbRowsToTaint: 2,
        deduplicationEnabled: false,
        enabled: true,
        maxConcurrentRequests: 4,
        maxContextOperations: 5,
        redactionEnabled: false,
        redactionNamePattern: 'REDACTION_NAME_PATTERN',
        redactionValuePattern: 'REDACTION_VALUE_PATTERN',
        requestSampling: 50,
      },
    })
    if (DD_MAJOR < 6) {
      assert.strictEqual(config.iast?.securityControlsConfiguration, 'SANITIZER:CODE_INJECTION:sanitizer.js:method')
    } else {
      assert.ok(!('iast.securityControlsConfiguration' in config))
    }
    assertObjectContains(config, {
      iast: {
        stackTrace: {
          enabled: false,
        },
        telemetryVerbosity: 'DEBUG',
      },
      llmobs: {
        agentlessEnabled: true,
        mlApp: 'myMlApp',
      },
    })
    assert.strictEqual(config.logLevel, logLevel)
    assert.strictEqual(config.logger, logger)
    assert.strictEqual(config.middlewareTracingEnabled, false)
    assert.deepStrictEqual(config.peerServiceMapping, { d: 'dd' })
    assertObjectContains(config, {
      plugins: false,
      port: '6218',
      protocolVersion: '0.5',
      remoteConfig: {
        pollInterval: 42,
      },
      reportHostname: true,
      runtimeMetrics: {
        enabled: true,
        eventLoop: false,
        gc: false,
      },
      runtimeMetricsRuntimeId: true,
      sampleRate: 0.5,
    })
    assert.deepStrictEqual(config.sampler, {
      rateLimit: 1000,
      rules: [
        { service: 'usersvc', name: 'healthcheck', sampleRate: 0.0 },
        { service: 'usersvc', sampleRate: 0.5 },
        { service: 'authsvc', sampleRate: 1.0 },
        { sampleRate: 0.1 },
      ],
      sampleRate: 0.5,
      spanSamplingRules: [
        { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
        { service: 'mysql', sampleRate: 0.5 },
        { service: 'mysql', sampleRate: 1.0 },
        { sampleRate: 0.1 },
      ],
    })
    assert.strictEqual(config.service, 'service')
    assert.deepStrictEqual(config.serviceMapping, { a: 'aa', b: 'bb' })
    assertObjectContains(config, {
      site: 'datadoghq.eu',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
    })
    assert.ok(Object.hasOwn(config, 'tags'))
    assertObjectContains(config.tags, {
      env: 'test',
      foo: 'bar',
    })
    assert.ok(Object.hasOwn(config.tags, 'runtime-id'))
    assert.match(config.tags['runtime-id'], /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    assertObjectContains(config.tags, {
      service: 'service',
      version: '0.1.0',
    })
    assertObjectContains(config, {
      traceId128BitGenerationEnabled: true,
      traceId128BitLoggingEnabled: true,
    })
    assert.deepStrictEqual(config.tracePropagationStyle?.extract, ['datadog'])
    assert.deepStrictEqual(config.tracePropagationStyle?.inject, ['datadog'])
    assert.strictEqual(config.version, '0.1.0')

    sinon.assert.calledOnce(updateConfig)

    assertObjectContains(updateConfig.getCall(0).args[0].sort(comparator), [
      { name: 'appsec.enabled', value: false, origin: 'code' },
      { name: 'clientIpEnabled', value: true, origin: 'code' },
      { name: 'clientIpHeader', value: 'x-true-client-ip', origin: 'code' },
      { name: 'codeOriginForSpans.enabled', value: false, origin: 'code' },
      { name: 'codeOriginForSpans.experimental.exit_spans.enabled', value: true, origin: 'code' },
      { name: 'dogstatsd.hostname', value: 'agent-dsd', origin: 'code' },
      { name: 'dogstatsd.port', value: '5218', origin: 'code' },
      { name: 'dynamicInstrumentation.enabled', value: true, origin: 'code' },
      { name: 'dynamicInstrumentation.probeFile', value: 'probes.json', origin: 'code' },
      { name: 'dynamicInstrumentation.redactedIdentifiers', value: ['foo', 'bar'], origin: 'code' },
      { name: 'dynamicInstrumentation.redactionExcludedIdentifiers', value: ['a', 'b', 'c'], origin: 'code' },
      { name: 'dynamicInstrumentation.uploadIntervalSeconds', value: 0.1, origin: 'code' },
      { name: 'env', value: 'test', origin: 'code' },
      { name: 'experimental.aiguard.enabled', value: true, origin: 'code' },
      { name: 'experimental.aiguard.endpoint', value: 'https://dd.datad0g.com/api/unstable/ai-guard', origin: 'code' },
      { name: 'experimental.aiguard.maxContentSize', value: 1024 * 1024, origin: 'code' },
      { name: 'experimental.aiguard.maxMessagesLength', value: 32, origin: 'code' },
      { name: 'experimental.aiguard.timeout', value: 2_000, origin: 'code' },
      { name: 'experimental.enableGetRumData', value: true, origin: 'code' },
      { name: 'experimental.exporter', value: 'log', origin: 'code' },
      { name: 'flushInterval', value: 5000, origin: 'code' },
      { name: 'flushMinSpans', value: 500, origin: 'code' },
      { name: 'hostname', value: 'agent', origin: 'code' },
      { name: 'iast.dbRowsToTaint', value: 2, origin: 'code' },
      { name: 'iast.deduplicationEnabled', value: false, origin: 'code' },
      { name: 'iast.enabled', value: true, origin: 'code' },
      { name: 'iast.maxConcurrentRequests', value: 4, origin: 'code' },
      { name: 'iast.maxContextOperations', value: 5, origin: 'code' },
      { name: 'iast.redactionEnabled', value: false, origin: 'code' },
      { name: 'iast.redactionNamePattern', value: 'REDACTION_NAME_PATTERN', origin: 'code' },
      { name: 'iast.redactionValuePattern', value: 'REDACTION_VALUE_PATTERN', origin: 'code' },
      { name: 'iast.requestSampling', value: 50, origin: 'code' },
      DD_MAJOR < 6 && {
        name: 'iast.securityControlsConfiguration',
        value: 'SANITIZER:CODE_INJECTION:sanitizer.js:method',
        origin: 'code',
      },
      { name: 'iast.stackTrace.enabled', value: false, origin: 'code' },
      { name: 'iast.telemetryVerbosity', value: 'DEBUG', origin: 'code' },
      { name: 'llmobs.agentlessEnabled', value: true, origin: 'code' },
      { name: 'llmobs.mlApp', value: 'myMlApp', origin: 'code' },
      { name: 'middlewareTracingEnabled', value: false, origin: 'code' },
      { name: 'peerServiceMapping', value: { d: 'dd' }, origin: 'code' },
      { name: 'plugins', value: false, origin: 'code' },
      { name: 'port', value: '6218', origin: 'code' },
      { name: 'protocolVersion', value: '0.5', origin: 'code' },
      { name: 'remoteConfig.pollInterval', value: 42, origin: 'code' },
      { name: 'reportHostname', value: true, origin: 'code' },
      { name: 'runtimeMetrics.enabled', value: true, origin: 'code' },
      { name: 'runtimeMetricsRuntimeId', value: true, origin: 'code' },
      { name: 'sampler.rateLimit', value: 1000, origin: 'code' },
      { name: 'sampler.rules', value: samplingRules, origin: 'code' },
      { name: 'sampleRate', value: 0.5, origin: 'code' },
      { name: 'service', value: 'service', origin: 'code' },
      { name: 'site', value: 'datadoghq.eu', origin: 'code' },
      { name: 'spanAttributeSchema', value: 'v1', origin: 'code' },
      { name: 'spanComputePeerService', value: true, origin: 'calculated' },
      { name: 'spanRemoveIntegrationFromService', value: true, origin: 'code' },
      { name: 'stats.enabled', value: false, origin: 'calculated' },
      { name: 'traceId128BitGenerationEnabled', value: true, origin: 'code' },
      { name: 'traceId128BitLoggingEnabled', value: true, origin: 'code' },
      { name: 'version', value: '0.1.0', origin: 'code' },
    ].filter(v => v).sort(comparator))
  })

  it('should initialize from the options with url taking precedence', () => {
    const logger = {}
    const tags = { foo: 'bar' }
    const config = getConfig({
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
      plugins: false,
    })

    assert.strictEqual(config.url.toString(), 'https://agent2:7777/')

    assertObjectContains(config, {
      site: 'datadoghq.eu',
      service: 'service',
      env: 'test',
      sampleRate: 0.5,
    })
    assert.strictEqual(config.logger, logger)
    assert.strictEqual(config.tags?.foo, 'bar')
    assertObjectContains(config, {
      flushInterval: 5000,
      flushMinSpans: 500,
      plugins: false,
    })
  })

  it('should warn if mixing shared and extract propagation style env vars', () => {
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE = 'datadog'

    getConfig()

    sinon.assert.calledWith(log.warn, 'Use either the DD_TRACE_PROPAGATION_STYLE ' +
      'environment variable or separate DD_TRACE_PROPAGATION_STYLE_INJECT and ' +
      'DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables')
  })

  it('should warn if mixing shared and inject propagation style env vars', () => {
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE = 'datadog'

    getConfig()

    sinon.assert.calledWith(log.warn, 'Use either the DD_TRACE_PROPAGATION_STYLE ' +
      'environment variable or separate DD_TRACE_PROPAGATION_STYLE_INJECT and ' +
      'DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables')
  })

  it('should warn if defaulting to v0 span attribute schema', () => {
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'foo'

    const config = getConfig()

    sinon.assert.calledWith(log.warn, 'Unexpected input for config.spanAttributeSchema, picked default', 'v0')
    assert.strictEqual(config.spanAttributeSchema, 'v0')
  })

  it('should parse integer range sets', () => {
    process.env.DD_GRPC_CLIENT_ERROR_STATUSES = '3,13,400-403'
    process.env.DD_GRPC_SERVER_ERROR_STATUSES = '3,13,400-403'

    let config = getConfig()

    assert.deepStrictEqual(config.grpc.client.error.statuses, [3, 13, 400, 401, 402, 403])
    assert.deepStrictEqual(config.grpc.server.error.statuses, [3, 13, 400, 401, 402, 403])

    process.env.DD_GRPC_CLIENT_ERROR_STATUSES = '1'
    process.env.DD_GRPC_SERVER_ERROR_STATUSES = '1'

    config = getConfig()

    assert.deepStrictEqual(config.grpc.client.error.statuses, [1])
    assert.deepStrictEqual(config.grpc.server.error.statuses, [1])

    process.env.DD_GRPC_CLIENT_ERROR_STATUSES = '2,10,13-15'
    process.env.DD_GRPC_SERVER_ERROR_STATUSES = '2,10,13-15'

    config = getConfig()

    assert.deepStrictEqual(config.grpc.client.error.statuses, [2, 10, 13, 14, 15])
    assert.deepStrictEqual(config.grpc.server.error.statuses, [2, 10, 13, 14, 15])
  })

  context('peer service tagging', () => {
    it('should activate peer service only if explicitly true in v0', () => {
      process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v0'
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'true'
      let config = getConfig()
      assert.strictEqual(config.spanComputePeerService, true)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'foo'
      config = getConfig()
      assert.strictEqual(config.spanComputePeerService, false)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'false'
      config = getConfig()
      assert.strictEqual(config.spanComputePeerService, false)

      delete process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
      config = getConfig()
      assert.strictEqual(config.spanComputePeerService, false)
    })

    it('should activate peer service in v1 unless explicitly false', () => {
      process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v1'
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'false'
      let config = getConfig()
      assert.strictEqual(config.spanComputePeerService, false)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'foo'
      config = getConfig()
      assert.strictEqual(config.spanComputePeerService, true)

      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'true'
      config = getConfig()
      assert.strictEqual(config.spanComputePeerService, true)

      delete process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
      config = getConfig()
      assert.strictEqual(config.spanComputePeerService, true)
    })
  })

  it('should give priority to the common agent environment variable', () => {
    process.env.DD_TRACE_AGENT_HOSTNAME = 'trace-agent'
    process.env.DD_AGENT_HOST = 'agent'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:foo'
    process.env.DD_TAGS = 'foo:bar,baz:qux'

    const config = getConfig()

    assert.strictEqual(config.hostname, 'agent')
    assertObjectContains(config.tags, { foo: 'foo', baz: 'qux' })
  })

  it('should give priority to the options', () => {
    process.env.DD_AI_GUARD_ENABLED = 'false'
    process.env.DD_AI_GUARD_ENDPOINT = 'https://dd.datadog.com/api/unstable/ai-guard'
    process.env.DD_AI_GUARD_MAX_CONTENT_SIZE = String(512 * 1024)
    process.env.DD_AI_GUARD_MAX_MESSAGES_LENGTH = '16'
    process.env.DD_AI_GUARD_TIMEOUT = '1000'
    process.env.DD_API_KEY = '123'
    process.env.DD_API_SECURITY_ENABLED = 'false'
    process.env.DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED = 'false'
    process.env.DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT = '42'
    process.env.DD_APM_TRACING_ENABLED = 'false'
    process.env.DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE = 'disabled'
    process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = 'disabled'
    process.env.DD_APPSEC_COLLECT_ALL_HEADERS = 'false'
    process.env.DD_APPSEC_ENABLED = 'false'
    process.env.DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_JSON_PATH // json and html here
    process.env.DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED = 'false'
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = BLOCKED_TEMPLATE_JSON_PATH // note the inversion between
    process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = BLOCKED_TEMPLATE_HTML_PATH // json and html here
    process.env.DD_APPSEC_MAX_COLLECTED_HEADERS = '11'
    process.env.DD_APPSEC_MAX_STACK_TRACE_DEPTH = '11'
    process.env.DD_APPSEC_MAX_STACK_TRACES = '11'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = '^$'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = '^$'
    process.env.DD_APPSEC_RASP_COLLECT_REQUEST_BODY = 'false'
    process.env.DD_APPSEC_RASP_ENABLED = 'true'
    process.env.DD_APPSEC_RULES = RECOMMENDED_JSON_PATH
    process.env.DD_APPSEC_STACK_TRACE_ENABLED = 'true'
    process.env.DD_APPSEC_TRACE_RATE_LIMIT = '11'
    process.env.DD_APPSEC_WAF_TIMEOUT = '11'
    process.env.DD_CODE_ORIGIN_FOR_SPANS_ENABLED = 'false'
    process.env.DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED = 'true'
    process.env.DD_DOGSTATSD_PORT = '5218'
    process.env.DD_DYNAMIC_INSTRUMENTATION_ENABLED = 'true'
    process.env.DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE = 'probes.json'
    process.env.DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS = 'foo,bar'
    process.env.DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS = 'a,b,c'
    process.env.DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS = '0.1'
    process.env.DD_ENV = 'test'
    process.env.DD_IAST_DB_ROWS_TO_TAINT = '2'
    process.env.DD_IAST_ENABLED = 'false'
    process.env.DD_IAST_REDACTION_NAME_PATTERN = 'name_pattern_to_be_overriden_by_options'
    process.env.DD_IAST_REDACTION_VALUE_PATTERN = 'value_pattern_to_be_overriden_by_options'
    process.env.DD_IAST_SECURITY_CONTROLS_CONFIGURATION = 'SANITIZER:CODE_INJECTION:sanitizer.js:method1'
    process.env.DD_IAST_STACK_TRACE_ENABLED = 'true'
    process.env.DD_LLMOBS_AGENTLESS_ENABLED = 'true'
    process.env.DD_LLMOBS_ML_APP = 'myMlApp'
    process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = '11'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED = 'true'
    process.env.DD_SERVICE = 'service'
    process.env.DD_SERVICE_MAPPING = 'a:aa'
    process.env.DD_SITE = 'datadoghq.eu'
    process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = 'true'
    process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = 'true'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_TRACE_AGENT_PROTOCOL_VERSION = '0.4'
    process.env.DD_TRACE_AGENT_URL = 'https://agent2:6218'
    process.env.DD_TRACE_CLIENT_IP_ENABLED = 'false'
    process.env.DD_TRACE_CLIENT_IP_HEADER = 'foo-bar-header'
    process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'log'
    process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED = 'true'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:bar,baz:qux'
    process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED = 'false'
    process.env.DD_TRACE_PARTIAL_FLUSH_MIN_SPANS = '2000'
    process.env.DD_TRACE_FLUSH_INTERVAL = '2000'
    process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = 'false'
    process.env.DD_TRACE_PEER_SERVICE_MAPPING = 'c:cc'
    process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'restart'
    process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT = 'datadog'
    process.env.DD_TRACE_PROPAGATION_STYLE_INJECT = 'datadog'
    process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = 'false'
    process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
    process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = 'v0'
    process.env.DD_VERSION = '0.0.0'

    const config = getConfig({
      apmTracingEnabled: true,
      appsec: {
        apiSecurity: {
          enabled: true,
          endpointCollectionEnabled: true,
          endpointCollectionMessageLimit: 150,
        },
        blockedTemplateGraphql: BLOCKED_TEMPLATE_GRAPHQL_PATH,
        blockedTemplateHtml: BLOCKED_TEMPLATE_HTML_PATH,
        blockedTemplateJson: BLOCKED_TEMPLATE_JSON_PATH,
        enabled: true,
        eventTracking: {
          mode: 'anonymous',
        },
        extendedHeadersCollection: {
          enabled: true,
          redaction: true,
          maxHeaders: 42,
        },
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        rasp: {
          enabled: false,
          bodyCollection: true,
        },
        rateLimit: 42,
        stackTrace: {
          enabled: false,
          maxDepth: 42,
          maxStackTraces: 5,
        },
        rules: RULES_JSON_PATH,
        wafTimeout: 42,
      },
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      codeOriginForSpans: {
        enabled: true,
        experimental: {
          exit_spans: {
            enabled: false,
          },
        },
      },
      dogstatsd: {
        port: 8888,
      },
      dynamicInstrumentation: {
        enabled: false,
        probeFile: 'probes2.json',
        redactedIdentifiers: ['foo2', 'bar2'],
        redactionExcludedIdentifiers: ['a2', 'b2'],
        uploadIntervalSeconds: 0.2,
      },
      env: 'development',
      experimental: {
        aiguard: {
          enabled: true,
          endpoint: 'https://dd.datad0g.com/api/unstable/ai-guard',
          maxContentSize: 1024 * 1024,
          maxMessagesLength: 32,
          timeout: 2000,
        },
        b3: false,
        traceparent: false,
        exporter: 'agent',
        enableGetRumData: false,
      },
      flushMinSpans: 500,
      flushInterval: 500,
      hostname: 'server',
      iast: {
        dbRowsToTaint: 3,
        enabled: true,
        redactionNamePattern: 'REDACTION_NAME_PATTERN',
        redactionValuePattern: 'REDACTION_VALUE_PATTERN',
        securityControlsConfiguration: 'SANITIZER:CODE_INJECTION:sanitizer.js:method2',
        stackTrace: {
          enabled: false,
        },
      },
      llmobs: {
        agentlessEnabled: false,
        mlApp: 'myOtherMlApp',
      },
      middlewareTracingEnabled: true,
      peerServiceMapping: {
        d: 'dd',
      },
      port: 7777,
      protocol: 'https',
      protocolVersion: '0.5',
      remoteConfig: {
        pollInterval: 42,
      },
      reportHostname: false,
      runtimeMetrics: false,
      runtimeMetricsRuntimeId: false,
      service: 'test',
      serviceMapping: {
        b: 'bb',
      },
      site: 'datadoghq.com',
      spanAttributeSchema: 'v1',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
      tags: {
        foo: 'foo',
      },
      traceId128BitGenerationEnabled: false,
      traceId128BitLoggingEnabled: false,
      tracePropagationStyle: {
        inject: [],
        extract: [],
      },
      version: '1.0.0',
    })

    assertObjectContains(config, {
      apmTracingEnabled: true,
      appsec: {
        apiSecurity: {
          enabled: true,
          endpointCollectionEnabled: true,
          endpointCollectionMessageLimit: 150,
        },
        blockedTemplateGraphql: BLOCKED_TEMPLATE_GRAPHQL,
        blockedTemplateHtml: BLOCKED_TEMPLATE_HTML,
        blockedTemplateJson: BLOCKED_TEMPLATE_JSON,
        rules: RULES_JSON_PATH,
        enabled: true,
        eventTracking: {
          mode: 'anonymous',
        },
        extendedHeadersCollection: {
          enabled: true,
          maxHeaders: 42,
          redaction: true,
        },
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        rasp: {
          bodyCollection: true,
          enabled: false,
        },
        rateLimit: 42,
        stackTrace: {
          enabled: false,
          maxDepth: 42,
          maxStackTraces: 5,
        },
        wafTimeout: 42,
      },
      clientIpEnabled: true,
      clientIpHeader: 'x-true-client-ip',
      codeOriginForSpans: {
        enabled: true,
        experimental: {
          exit_spans: {
            enabled: false,
          },
        },
      },
      dogstatsd: {
        hostname: 'server',
        port: '8888',
      },
      dynamicInstrumentation: {
        enabled: false,
        probeFile: 'probes2.json',
        redactedIdentifiers: ['foo2', 'bar2'],
        redactionExcludedIdentifiers: ['a2', 'b2'],
        uploadIntervalSeconds: 0.2,
      },
      env: 'development',
      experimental: {
        aiguard: {
          enabled: true,
          endpoint: 'https://dd.datad0g.com/api/unstable/ai-guard',
          maxContentSize: 1024 * 1024,
          maxMessagesLength: 32,
          timeout: 2000,
        },
        enableGetRumData: false,
        exporter: 'agent',
      },
      flushMinSpans: 500,
      flushInterval: 500,
      iast: {
        dbRowsToTaint: 3,
        deduplicationEnabled: true,
        enabled: true,
        maxConcurrentRequests: 2,
        maxContextOperations: 2,
        redactionEnabled: true,
        redactionNamePattern: 'REDACTION_NAME_PATTERN',
        redactionValuePattern: 'REDACTION_VALUE_PATTERN',
        requestSampling: 30,
        securityControlsConfiguration: 'SANITIZER:CODE_INJECTION:sanitizer.js:method' + (DD_MAJOR < 6 ? '2' : '1'),
        stackTrace: {
          enabled: false,
        },
      },
      llmobs: {
        agentlessEnabled: false,
        mlApp: 'myOtherMlApp',
      },
      middlewareTracingEnabled: true,
      peerServiceMapping: { d: 'dd' },
      protocolVersion: '0.5',
      remoteConfig: {
        pollInterval: 42,
      },
      reportHostname: false,
      runtimeMetrics: {
        enabled: false,
      },
      runtimeMetricsRuntimeId: false,
      service: 'test',
      site: 'datadoghq.com',
      spanAttributeSchema: 'v1',
      spanComputePeerService: true,
      spanRemoveIntegrationFromService: true,
      traceId128BitGenerationEnabled: false,
      traceId128BitLoggingEnabled: false,
      version: '1.0.0',
      serviceMapping: { b: 'bb' },
      tags: {
        foo: 'foo',
        service: 'test',
        version: '1.0.0',
        env: 'development',
      },
      tracePropagationStyle: {
        extract: [],
        inject: [],
      },
    })
    assert.strictEqual(config.url.toString(), 'https://agent2:6218/')
  })

  it('should give priority to non-experimental options', () => {
    const config = getConfig({
      appsec: {
        apiSecurity: {
          enabled: true,
          endpointCollectionEnabled: true,
          endpointCollectionMessageLimit: 500,
        },
        blockedTemplateGraphql: undefined,
        blockedTemplateHtml: undefined,
        blockedTemplateJson: undefined,
        enabled: true,
        eventTracking: {
          mode: 'disabled',
        },
        extendedHeadersCollection: {
          enabled: true,
          redaction: true,
          maxHeaders: 42,
        },
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*',
        rasp: {
          enabled: false,
          bodyCollection: true,
        },
        rateLimit: 42,
        rules: undefined,
        wafTimeout: 42,
      },
      iast: {
        dbRowsToTaint: 3,
        deduplicationEnabled: false,
        enabled: true,
        maxConcurrentRequests: 3,
        maxContextOperations: 4,
        redactionEnabled: false,
        redactionNamePattern: 'REDACTION_NAME_PATTERN',
        redactionValuePattern: 'REDACTION_VALUE_PATTERN',
        requestSampling: 15,
        stackTrace: {
          enabled: false,
        },
        telemetryVerbosity: 'DEBUG',
      },
      experimental: {
        appsec: {
          apiSecurity: {
            enabled: false,
            endpointCollectionEnabled: false,
            endpointCollectionMessageLimit: 42,
          },
          blockedTemplateGraphql: BLOCKED_TEMPLATE_GRAPHQL_PATH,
          blockedTemplateHtml: BLOCKED_TEMPLATE_HTML_PATH,
          blockedTemplateJson: BLOCKED_TEMPLATE_JSON_PATH,
          enabled: false,
          eventTracking: {
            mode: 'anonymous',
          },
          extendedHeadersCollection: {
            enabled: false,
            redaction: false,
            maxHeaders: 0,
          },
          obfuscatorKeyRegex: '^$',
          obfuscatorValueRegex: '^$',
          rasp: {
            enabled: true,
            bodyCollection: false,
          },
          rateLimit: 11,
          rules: RULES_JSON_PATH,
          wafTimeout: 11,
        },
        iast: {
          dbRowsToTaint: 2,
          deduplicationEnabled: true,
          enabled: false,
          maxConcurrentRequests: 6,
          maxContextOperations: 7,
          redactionEnabled: true,
          redactionNamePattern: 'IGNORED_REDACTION_NAME_PATTERN',
          redactionValuePattern: 'IGNORED_REDACTION_VALUE_PATTERN',
          requestSampling: 25,
          stackTrace: {
            enabled: true,
          },
          telemetryVerbosity: 'OFF',
        },
      },
    })

    assert.deepStrictEqual(config.appsec, {
      apiSecurity: {
        enabled: true,
        sampleDelay: 30,
        endpointCollectionEnabled: true,
        endpointCollectionMessageLimit: 500,
        downstreamBodyAnalysisSampleRate: 0.5,
        maxDownstreamRequestBodyAnalysis: 1,
      },
      blockedTemplateGraphql: undefined,
      blockedTemplateHtml: undefined,
      blockedTemplateJson: undefined,
      enabled: true,
      eventTracking: {
        mode: 'disabled',
      },
      extendedHeadersCollection: {
        enabled: true,
        redaction: true,
        maxHeaders: 42,
      },
      obfuscatorKeyRegex: '.*',
      obfuscatorValueRegex: '.*',
      rasp: {
        enabled: false,
        bodyCollection: true,
      },
      rateLimit: 42,
      rules: undefined,
      sca: {
        enabled: undefined,
      },
      stackTrace: {
        enabled: true,
        maxStackTraces: 2,
        maxDepth: 32,
      },
      wafTimeout: 42,
    })

    assert.deepStrictEqual(config.iast, {
      dbRowsToTaint: 3,
      deduplicationEnabled: false,
      enabled: true,
      maxConcurrentRequests: 3,
      maxContextOperations: 4,
      redactionEnabled: false,
      redactionNamePattern: 'REDACTION_NAME_PATTERN',
      redactionValuePattern: 'REDACTION_VALUE_PATTERN',
      requestSampling: 15,
      securityControlsConfiguration: undefined,
      stackTrace: {
        enabled: false,
      },
      telemetryVerbosity: 'DEBUG',
    })
  })

  it('should give priority to the options especially url', () => {
    process.env.DD_TRACE_AGENT_URL = 'http://agent2:6218'
    process.env.DD_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DD_TRACE_AGENT_PORT = '6218'
    process.env.DD_SERVICE_NAME = 'service'
    process.env.DD_ENV = 'test'

    const config = getConfig({
      url: 'https://agent3:7778',
      protocol: 'http',
      hostname: 'server',
      port: 7777,
      service: 'test',
      env: 'development',
    })

    assert.strictEqual(config.url.toString(), 'https://agent3:7778/')

    assertObjectContains(config, {
      service: 'test',
      env: 'development',
    })
  })

  it('should give priority to individual options over tags', () => {
    process.env.DD_SERVICE = 'test'
    process.env.DD_ENV = 'dev'
    process.env.DD_VERSION = '1.0.0'
    process.env.DD_TAGS = 'service=foo,env=bar,version=0.0.0'

    const config = getConfig()

    assertObjectContains(config.tags, {
      service: 'test',
      env: 'dev',
      version: '1.0.0',
    })
  })

  it('should sanitize the sample rate to be between 0 and 1', () => {
    assert.strictEqual(getConfig({ sampleRate: -1 })?.sampleRate, 0)
    assert.strictEqual(getConfig({ sampleRate: 2 })?.sampleRate, 1)
    assert.strictEqual(getConfig({ sampleRate: NaN })?.sampleRate, undefined)
  })

  it('should ignore empty service names', () => {
    process.env.DD_SERVICE = ''

    const config = getConfig()

    assertObjectContains(config.tags, {
      service: 'node',
    })
  })

  it('should support tags for setting primary fields', () => {
    const config = getConfig({
      tags: {
        service: 'service',
        env: 'test',
        version: '0.1.0',
      },
    })

    assertObjectContains(config, {
      service: 'service',
      version: '0.1.0',
      env: 'test',
    })
  })

  it('should trim whitespace characters around keys', () => {
    process.env.DD_TAGS = 'foo:bar, baz:qux'

    const config = getConfig()

    assertObjectContains(config.tags, { foo: 'bar', baz: 'qux' })
  })

  it('should not transform the lookup parameter', () => {
    const lookup = () => 'test'
    const config = getConfig({ lookup })

    assert.strictEqual(config.lookup, lookup)
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if AWS_LAMBDA_FUNCTION_NAME is present', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-great-lambda-function'

    const config = getConfig()

    assert.strictEqual(config.telemetry.enabled, false)
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if FUNCTION_NAME and GCP_PROJECT are present', () => {
    // FUNCTION_NAME and GCP_PROJECT env vars indicate a gcp function with a deprecated runtime
    process.env.FUNCTION_NAME = 'function_name'
    process.env.GCP_PROJECT = 'project_name'

    const config = getConfig()

    assert.strictEqual(config.telemetry.enabled, false)
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if K_SERVICE and FUNCTION_TARGET are present', () => {
    // K_SERVICE and FUNCTION_TARGET env vars indicate a gcp function with a newer runtime
    process.env.K_SERVICE = 'function_name'
    process.env.FUNCTION_TARGET = 'function_target'

    const config = getConfig()

    assert.strictEqual(config.telemetry.enabled, false)
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED if Azure Consumption Plan Function', () => {
    // AzureWebJobsScriptRoot and FUNCTIONS_EXTENSION_VERSION env vars indicate an azure function
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'
    process.env.WEBSITE_SKU = 'Dynamic'

    const config = getConfig()

    assert.strictEqual(config.telemetry.enabled, false)
  })

  it('should set telemetry default values', () => {
    const config = getConfig()

    assert.notStrictEqual(config.telemetry, undefined)
    assert.strictEqual(config.telemetry.enabled, true)
    assert.strictEqual(config.telemetry.heartbeatInterval, 60000)
    assert.strictEqual(config.telemetry.logCollection, true)
    assert.strictEqual(config.telemetry.debug, false)
    assert.strictEqual(config.telemetry.metrics, true)
  })

  it('should set DD_TELEMETRY_HEARTBEAT_INTERVAL', () => {
    const origTelemetryHeartbeatIntervalValue = process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL
    process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL = '42'

    const config = getConfig()

    assert.strictEqual(config.telemetry.heartbeatInterval, 42000)

    process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL = origTelemetryHeartbeatIntervalValue
  })

  it('should not set DD_INSTRUMENTATION_TELEMETRY_ENABLED', () => {
    const origTraceTelemetryValue = process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED
    process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

    const config = getConfig()

    assert.strictEqual(config.telemetry.enabled, false)

    process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = origTraceTelemetryValue
  })

  it('should not set DD_TELEMETRY_METRICS_ENABLED', () => {
    const origTelemetryMetricsEnabledValue = process.env.DD_TELEMETRY_METRICS_ENABLED
    process.env.DD_TELEMETRY_METRICS_ENABLED = 'false'

    const config = getConfig()

    assert.strictEqual(config.telemetry.metrics, false)

    process.env.DD_TELEMETRY_METRICS_ENABLED = origTelemetryMetricsEnabledValue
  })

  it('should disable log collection if DD_TELEMETRY_LOG_COLLECTION_ENABLED is false', () => {
    const origLogsValue = process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED
    process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED = 'false'

    const config = getConfig()

    assert.strictEqual(config.telemetry.logCollection, false)

    process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED = origLogsValue
  })

  it('should set DD_TELEMETRY_DEBUG', () => {
    const origTelemetryDebugValue = process.env.DD_TELEMETRY_DEBUG
    process.env.DD_TELEMETRY_DEBUG = 'true'

    const config = getConfig()

    assert.strictEqual(config.telemetry.debug, true)

    process.env.DD_TELEMETRY_DEBUG = origTelemetryDebugValue
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if AWS_LAMBDA_FUNCTION_NAME is present', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-great-lambda-function'

    const config = getConfig()

    assert.strictEqual(config.remoteConfig.enabled, false)
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if FUNCTION_NAME and GCP_PROJECT are present', () => {
    process.env.FUNCTION_NAME = 'function_name'
    process.env.GCP_PROJECT = 'project_name'

    const config = getConfig()

    assert.strictEqual(config.remoteConfig.enabled, false)
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if K_SERVICE and FUNCTION_TARGET are present', () => {
    process.env.K_SERVICE = 'function_name'
    process.env.FUNCTION_TARGET = 'function_target'

    const config = getConfig()

    assert.strictEqual(config.remoteConfig.enabled, false)
  })

  it('should not set DD_REMOTE_CONFIGURATION_ENABLED if Azure Functions env vars are present', () => {
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'
    process.env.WEBSITE_SKU = 'Dynamic'

    const config = getConfig()

    assert.strictEqual(config.remoteConfig.enabled, false)
  })

  it('should send empty array when remote config is called on empty options', () => {
    const config = getConfig()

    config.setRemoteConfig({})

    sinon.assert.calledTwice(updateConfig)
    assert.deepStrictEqual(updateConfig.getCall(1).args[0], [])
  })

  it('should send remote config changes to telemetry', () => {
    const config = getConfig()

    config.setRemoteConfig({
      tracing_sampling_rate: 0,
    })

    assert.deepStrictEqual(updateConfig.getCall(1).args[0], [
      { name: 'sampleRate', value: 0, origin: 'remote_config' },
    ])
  })

  it('should reformat tags from sampling rules when set through remote configuration', () => {
    const config = getConfig()

    config.setRemoteConfig({
      tracing_sampling_rules: [
        {
          resource: '*',
          tags: [
            { key: 'tag-a', value_glob: 'tag-a-val*' },
            { key: 'tag-b', value_glob: 'tag-b-val*' },
          ],
          provenance: 'customer',
        },
      ],
    })
    assert.deepStrictEqual(config.sampler, {
      spanSamplingRules: undefined,
      rateLimit: 100,
      rules: [
        {
          resource: '*',
          tags: { 'tag-a': 'tag-a-val*', 'tag-b': 'tag-b-val*' },
          provenance: 'customer',
        },
      ],
      sampleRate: undefined,
    })
  })

  it('should have consistent runtime-id after remote configuration updates tags', () => {
    const config = getConfig()
    const runtimeId = config.tags['runtime-id']
    config.setRemoteConfig({
      tracing_tags: { foo: 'bar' },
    })

    assert.strictEqual(config.tags?.foo, 'bar')
    assert.strictEqual(config.tags?.['runtime-id'], runtimeId)
  })

  it('should ignore invalid iast.requestSampling', () => {
    const config = getConfig({
      experimental: {
        iast: {
          requestSampling: 105,
        },
      },
    })
    assert.strictEqual(config.iast.requestSampling, 30)
  })

  it('should load span sampling rules from json file', () => {
    const path = '../fixtures/config/span-sampling-rules.json'
    process.env.DD_SPAN_SAMPLING_RULES_FILE = require.resolve(path)

    const config = getConfig()

    assert.deepStrictEqual(config.sampler?.spanSamplingRules, [
      { service: 'mysql', name: 'mysql.query', sampleRate: 0.0, maxPerSecond: 1 },
      { service: 'mysql', sampleRate: 0.5 },
      { service: 'mysql', sampleRate: 1.0 },
      { sampleRate: 0.1 },
    ])
  })

  it('should skip appsec config files if they do not exist', () => {
    const error = new Error('file not found')
    fs.readFileSync = () => { throw error }

    const config = getConfig({
      appsec: {
        enabled: true,
        rules: 'path/to/rules.json',
        blockedTemplateHtml: 'DOES_NOT_EXIST.html',
        blockedTemplateJson: 'DOES_NOT_EXIST.json',
        blockedTemplateGraphql: 'DOES_NOT_EXIST.json',
      },
    })

    sinon.assert.callCount(log.error, 3)
    sinon.assert.calledWithExactly(log.error.firstCall, 'Error reading file %s', 'DOES_NOT_EXIST.json', error)
    sinon.assert.calledWithExactly(log.error.secondCall, 'Error reading file %s', 'DOES_NOT_EXIST.html', error)
    sinon.assert.calledWithExactly(log.error.thirdCall, 'Error reading file %s', 'DOES_NOT_EXIST.json', error)

    assert.strictEqual(config.appsec.enabled, true)
    assert.strictEqual(config.appsec.rules, 'path/to/rules.json')
    assert.strictEqual(config.appsec.blockedTemplateHtml, undefined)
    assert.strictEqual(config.appsec.blockedTemplateJson, undefined)
    assert.strictEqual(config.appsec.blockedTemplateGraphql, undefined)
  })

  it('should enable api security with DD_EXPERIMENTAL_API_SECURITY_ENABLED', () => {
    process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED = 'true'

    const config = getConfig()

    assert.strictEqual(config.appsec.apiSecurity.enabled, true)
  })

  it('should disable api security with DD_EXPERIMENTAL_API_SECURITY_ENABLED', () => {
    process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED = 'false'

    const config = getConfig()

    assert.strictEqual(config.appsec.apiSecurity.enabled, false)
  })

  it('should ignore DD_EXPERIMENTAL_API_SECURITY_ENABLED with DD_API_SECURITY_ENABLED=true', () => {
    process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED = 'false'
    process.env.DD_API_SECURITY_ENABLED = 'true'

    const config = getConfig()

    assert.strictEqual(config.appsec.apiSecurity.enabled, true)
  })

  it('should prioritize DD_DOGSTATSD_HOST over DD_DOGSTATSD_HOSTNAME', () => {
    process.env.DD_DOGSTATSD_HOSTNAME = 'dsd-agent'
    process.env.DD_DOGSTATSD_HOST = 'localhost'

    const config = getConfig()

    assert.strictEqual(config.dogstatsd?.hostname, 'localhost')
  })

  context('auto configuration w/ unix domain sockets', () => {
    context('socket does not exist', () => {
      it('should not be used', () => {
        const config = getConfig()

        assert.strictEqual(config.url, '')
      })
    })

    context('socket exists', () => {
      beforeEach(() => {
        existsSyncReturn = true
      })

      it('should be used when no options and no env vars', () => {
        const config = getConfig()

        if (os.type() === 'Windows_NT') {
          assert.strictEqual(existsSyncParam, undefined)
          assert.strictEqual(config.url, '')
        } else {
          assert.strictEqual(existsSyncParam, '/var/run/datadog/apm.socket')
          assert.strictEqual(config.url.toString(), 'unix:///var/run/datadog/apm.socket')
        }
      })

      it('should not be used when DD_TRACE_AGENT_URL provided', () => {
        process.env.DD_TRACE_AGENT_URL = 'https://example.com/'

        const config = getConfig()

        assert.strictEqual(config.url.toString(), 'https://example.com/')
      })

      it('should not be used when DD_TRACE_URL provided', () => {
        process.env.DD_TRACE_URL = 'https://example.com/'

        const config = getConfig()

        assert.strictEqual(config.url.toString(), 'https://example.com/')
      })

      it('should not be used when options.url provided', () => {
        const config = getConfig({ url: 'https://example.com/' })

        assert.strictEqual(config.url.toString(), 'https://example.com/')
      })

      it('should not be used when DD_TRACE_AGENT_PORT provided', () => {
        process.env.DD_TRACE_AGENT_PORT = '12345'

        const config = getConfig()

        assert.strictEqual(config.url, '')
      })

      it('should not be used when options.port provided', () => {
        const config = getConfig({ port: 12345 })

        assert.strictEqual(config.url, '')
      })

      it('should not be used when DD_TRACE_AGENT_HOSTNAME provided', () => {
        process.env.DD_TRACE_AGENT_HOSTNAME = 'example.com'

        const config = getConfig()

        assert.strictEqual(config.url, '')
      })

      it('should not be used when DD_AGENT_HOST provided', () => {
        process.env.DD_AGENT_HOST = 'example.com'

        const config = getConfig()

        assert.strictEqual(config.url, '')
      })

      it('should not be used when options.hostname provided', () => {
        const config = getConfig({ hostname: 'example.com' })

        assert.strictEqual(config.url, '')
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
      delete process.env.DD_CIVISIBILITY_FLAKY_RETRY_ENABLED
      delete process.env.DD_CIVISIBILITY_FLAKY_RETRY_COUNT
      delete process.env.DD_TEST_SESSION_NAME
      delete process.env.JEST_WORKER_ID
      delete process.env.DD_TEST_FAILED_TEST_REPLAY_ENABLED
      delete process.env.DD_AGENTLESS_LOG_SUBMISSION_ENABLED
      options = {}
    })
    context('ci visibility mode is enabled', () => {
      beforeEach(() => {
        options = { isCiVisibility: true }
      })
      it('should activate git upload by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.isGitUploadEnabled, true)
      })
      it('should disable git upload if the DD_CIVISIBILITY_GIT_UPLOAD_ENABLED is set to false', () => {
        process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = 'false'
        const config = getConfig(options)
        assert.strictEqual(config.isGitUploadEnabled, false)
      })
      it('should activate ITR by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.isIntelligentTestRunnerEnabled, true)
      })
      it('should disable ITR if DD_CIVISIBILITY_ITR_ENABLED is set to false', () => {
        process.env.DD_CIVISIBILITY_ITR_ENABLED = 'false'
        const config = getConfig(options)
        assert.strictEqual(config.isIntelligentTestRunnerEnabled, false)
      })
      it('should enable manual testing API by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.isManualApiEnabled, true)
      })
      it('should disable manual testing API if DD_CIVISIBILITY_MANUAL_API_ENABLED is set to false', () => {
        process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED = 'false'
        const config = getConfig(options)
        assert.strictEqual(config.isManualApiEnabled, false)
      })
      it('should disable memcached command tagging by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.memcachedCommandEnabled, false)
      })
      it('should enable memcached command tagging if DD_TRACE_MEMCACHED_COMMAND_ENABLED is enabled', () => {
        process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED = 'true'
        const config = getConfig(options)
        assert.strictEqual(config.memcachedCommandEnabled, true)
      })
      it('should enable telemetry', () => {
        const config = getConfig(options)
        assert.strictEqual(config.telemetry?.enabled, true)
      })
      it('should enable early flake detection by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.isEarlyFlakeDetectionEnabled, true)
      })
      it('should disable early flake detection if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', () => {
        process.env.DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED = 'false'
        const config = getConfig(options)
        assert.strictEqual(config.isEarlyFlakeDetectionEnabled, false)
      })
      it('should enable flaky test retries by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.isFlakyTestRetriesEnabled, true)
      })
      it('should disable flaky test retries if isFlakyTestRetriesEnabled is false', () => {
        process.env.DD_CIVISIBILITY_FLAKY_RETRY_ENABLED = 'false'
        const config = getConfig(options)
        assert.strictEqual(config.isFlakyTestRetriesEnabled, false)
      })
      it('should read DD_CIVISIBILITY_FLAKY_RETRY_COUNT if present', () => {
        process.env.DD_CIVISIBILITY_FLAKY_RETRY_COUNT = '4'
        const config = getConfig(options)
        assert.strictEqual(config.flakyTestRetriesCount, 4)
      })
      it('should default DD_CIVISIBILITY_FLAKY_RETRY_COUNT to 5', () => {
        const config = getConfig(options)
        assert.strictEqual(config.flakyTestRetriesCount, 5)
      })
      it('should round non integer values of DD_CIVISIBILITY_FLAKY_RETRY_COUNT', () => {
        process.env.DD_CIVISIBILITY_FLAKY_RETRY_COUNT = '4.1'
        const config = getConfig(options)
        assert.strictEqual(config.flakyTestRetriesCount, 4)
      })
      it('should set the default to DD_CIVISIBILITY_FLAKY_RETRY_COUNT if it is not a number', () => {
        process.env.DD_CIVISIBILITY_FLAKY_RETRY_COUNT = 'a'
        const config = getConfig(options)
        assert.strictEqual(config.flakyTestRetriesCount, 5)
      })
      it('should set the session name if DD_TEST_SESSION_NAME is set', () => {
        process.env.DD_TEST_SESSION_NAME = 'my-test-session'
        const config = getConfig(options)
        assert.strictEqual(config.ciVisibilityTestSessionName, 'my-test-session')
      })
      it('should not enable agentless log submission by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.ciVisAgentlessLogSubmissionEnabled, false)
      })
      it('should enable agentless log submission if DD_AGENTLESS_LOG_SUBMISSION_ENABLED is true', () => {
        process.env.DD_AGENTLESS_LOG_SUBMISSION_ENABLED = 'true'
        const config = getConfig(options)
        assert.strictEqual(config.ciVisAgentlessLogSubmissionEnabled, true)
      })
      it('should set isTestDynamicInstrumentationEnabled by default', () => {
        const config = getConfig(options)
        assert.strictEqual(config.isTestDynamicInstrumentationEnabled, true)
      })
      it('should set isTestDynamicInstrumentationEnabled to false if DD_TEST_FAILED_TEST_REPLAY_ENABLED is false',
        () => {
          process.env.DD_TEST_FAILED_TEST_REPLAY_ENABLED = 'false'
          const config = getConfig(options)
          assert.strictEqual(config.isTestDynamicInstrumentationEnabled, false)
        })
    })
    context('ci visibility mode is not enabled', () => {
      it('should not activate intelligent test runner or git metadata upload', () => {
        process.env.DD_CIVISIBILITY_ITR_ENABLED = 'true'
        process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = 'true'
        const config = getConfig(options)
        assertObjectContains(config, {
          isIntelligentTestRunnerEnabled: false,
          isGitUploadEnabled: false,
        })
      })
    })
    it('disables telemetry if inside a jest worker', () => {
      process.env.JEST_WORKER_ID = '1'
      const config = getConfig(options)
      assert.strictEqual(config.telemetry.enabled, false)
    })
  })

  context('sci embedding', () => {
    const DUMMY_COMMIT_SHA = 'b7b5dfa992008c77ab3f8a10eb8711e0092445b0'
    const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/dd-trace-js.git'
    const DD_GIT_PROPERTIES_FILE = require.resolve('../fixtures/config/git.properties')
    const DD_GIT_FOLDER_PATH = path.join(__dirname, '..', 'fixtures', 'config', 'git-folder')
    let ddTags
    beforeEach(() => {
      ddTags = process.env.DD_TAGS
    })
    afterEach(() => {
      delete process.env.DD_GIT_PROPERTIES_FILE
      delete process.env.DD_GIT_COMMIT_SHA
      delete process.env.DD_GIT_REPOSITORY_URL
      delete process.env.DD_TRACE_GIT_METADATA_ENABLED
      delete process.env.DD_GIT_FOLDER_PATH
      process.env.DD_TAGS = ddTags
    })
    it('reads DD_GIT_* env vars', () => {
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL
      const config = getConfig({})
      assert.strictEqual(config.commitSHA, DUMMY_COMMIT_SHA)
      assert.strictEqual(config.repositoryUrl, DUMMY_REPOSITORY_URL)
    })
    it('reads DD_GIT_* env vars and filters out user data', () => {
      process.env.DD_GIT_REPOSITORY_URL = 'https://user:password@github.com/DataDog/dd-trace-js.git'
      const config = getConfig({})
      assert.strictEqual(config.repositoryUrl, 'https://github.com/DataDog/dd-trace-js.git')
    })
    it('reads DD_TAGS env var', () => {
      process.env.DD_TAGS = `git.commit.sha:${DUMMY_COMMIT_SHA},git.repository_url:${DUMMY_REPOSITORY_URL}`
      process.env.DD_GIT_REPOSITORY_URL = DUMMY_REPOSITORY_URL
      const config = getConfig({})
      assert.strictEqual(config.commitSHA, DUMMY_COMMIT_SHA)
      assert.strictEqual(config.repositoryUrl, DUMMY_REPOSITORY_URL)
    })
    it('reads git.properties if it is available', () => {
      process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
      const config = getConfig({})
      assert.strictEqual(config.commitSHA, '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d')
      assert.strictEqual(config.repositoryUrl, DUMMY_REPOSITORY_URL)
    })
    it('does not crash if git.properties is not available', () => {
      process.env.DD_GIT_PROPERTIES_FILE = '/does/not/exist'

      // Should not throw
      const config = getConfig({})
      assert.ok(config !== null && typeof config === 'object' && !Array.isArray(config))
    })
    it('does not read git.properties if env vars are passed', () => {
      process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      process.env.DD_GIT_REPOSITORY_URL = 'https://github.com:DataDog/dd-trace-js.git'
      const config = getConfig({})
      assert.strictEqual(config.commitSHA, DUMMY_COMMIT_SHA)
      assert.strictEqual(config.repositoryUrl, 'https://github.com:DataDog/dd-trace-js.git')
    })
    it('still reads git.properties if one of the env vars is missing', () => {
      process.env.DD_GIT_PROPERTIES_FILE = DD_GIT_PROPERTIES_FILE
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      const config = getConfig({})
      assert.strictEqual(config.commitSHA, DUMMY_COMMIT_SHA)
      assert.strictEqual(config.repositoryUrl, DUMMY_REPOSITORY_URL)
    })
    it('reads git.properties and filters out credentials', () => {
      process.env.DD_GIT_PROPERTIES_FILE = require.resolve('../fixtures/config/git.properties.credentials')
      const config = getConfig({})
      assertObjectContains(config, {
        commitSHA: '4e7da8069bcf5ffc8023603b95653e2dc99d1c7d',
        repositoryUrl: 'https://github.com/datadog/dd-trace-js',
      })
    })
    it('does not read git metadata if DD_TRACE_GIT_METADATA_ENABLED is false', () => {
      process.env.DD_TRACE_GIT_METADATA_ENABLED = 'false'
      const config = getConfig({})
      assert.ok(!(Object.hasOwn(config, 'commitSHA')))
      assert.ok(!(Object.hasOwn(config, 'repositoryUrl')))
    })
    it('reads .git/ folder if it is available', () => {
      process.env.DD_GIT_FOLDER_PATH = DD_GIT_FOLDER_PATH
      const config = getConfig({})
      assertObjectContains(config, {
        repositoryUrl: 'git@github.com:DataDog/dd-trace-js.git',
        commitSHA: '964886d9ec0c9fc68778e4abb0aab4d9982ce2b5',
      })
    })
    it('does not crash if .git/ folder is not available', () => {
      process.env.DD_GIT_FOLDER_PATH = '/does/not/exist/'

      // Should not throw
      const config = getConfig({})
      assert.ok(config !== null && typeof config === 'object' && !Array.isArray(config))
    })
    it('does not read .git/ folder if env vars are passed', () => {
      process.env.DD_GIT_FOLDER_PATH = DD_GIT_FOLDER_PATH
      process.env.DD_GIT_COMMIT_SHA = DUMMY_COMMIT_SHA
      process.env.DD_GIT_REPOSITORY_URL = 'https://github.com:DataDog/dd-trace-js.git'
      const config = getConfig({})
      assert.strictEqual(config.commitSHA, DUMMY_COMMIT_SHA)
      assert.strictEqual(config.repositoryUrl, 'https://github.com:DataDog/dd-trace-js.git')
    })
    it('still reads .git/ if one of the env vars is missing', () => {
      process.env.DD_GIT_FOLDER_PATH = DD_GIT_FOLDER_PATH
      process.env.DD_GIT_REPOSITORY_URL = 'git@github.com:DataDog/dummy-dd-trace-js.git'
      const config = getConfig({})
      assertObjectContains(config, {
        commitSHA: '964886d9ec0c9fc68778e4abb0aab4d9982ce2b5',
        repositoryUrl: 'git@github.com:DataDog/dummy-dd-trace-js.git',
      })
    })
  })

  context('llmobs config', () => {
    it('should disable llmobs by default', () => {
      const config = getConfig()
      assert.strictEqual(config.llmobs.enabled, false)

      // check origin computation
      assertObjectContains(updateConfig.getCall(0).args[0], [{
        name: 'llmobs.enabled', value: false, origin: 'default',
      }])
    })

    it('should enable llmobs if DD_LLMOBS_ENABLED is set to true', () => {
      process.env.DD_LLMOBS_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.llmobs.enabled, true)

      // check origin computation
      assertObjectContains(updateConfig.getCall(0).args[0], [{
        name: 'llmobs.enabled', value: true, origin: 'env_var',
      }])
    })

    it('should disable llmobs if DD_LLMOBS_ENABLED is set to false', () => {
      process.env.DD_LLMOBS_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.llmobs.enabled, false)

      // check origin computation
      assertObjectContains(updateConfig.getCall(0).args[0], [{
        name: 'llmobs.enabled', value: false, origin: 'env_var',
      }])
    })

    it('should enable llmobs with options and DD_LLMOBS_ENABLED is not set', () => {
      const config = getConfig({ llmobs: {} })
      assert.strictEqual(config.llmobs.enabled, true)

      // check origin computation
      assertObjectContains(updateConfig.getCall(0).args[0], [{
        name: 'llmobs.enabled', value: true, origin: 'code',
      }])
    })

    it('should have DD_LLMOBS_ENABLED take priority over options', () => {
      process.env.DD_LLMOBS_ENABLED = 'false'
      const config = getConfig({ llmobs: {} })
      assert.strictEqual(config.llmobs.enabled, false)

      // check origin computation
      assertObjectContains(updateConfig.getCall(0).args[0], [{
        name: 'llmobs.enabled', value: false, origin: 'env_var',
      }])
    })
  })

  context('payload tagging', () => {
    let env

    const staticConfig = require('../../src/payload-tagging/config/aws.json')

    beforeEach(() => {
      env = process.env
    })

    afterEach(() => {
      process.env = env
    })

    it('defaults', () => {
      const taggingConfig = getConfig().cloudPayloadTagging
      assertObjectContains(taggingConfig, {
        requestsEnabled: false,
        responsesEnabled: false,
        maxDepth: 10,
      })
    })

    it('enabling requests with no additional filter', () => {
      process.env.DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING = 'all'
      const taggingConfig = getConfig().cloudPayloadTagging
      assertObjectContains(taggingConfig, {
        requestsEnabled: true,
        responsesEnabled: false,
        maxDepth: 10,
      })
      const awsRules = taggingConfig.rules.aws
      for (const [serviceName, service] of Object.entries(awsRules)) {
        assert.deepStrictEqual(service.request, staticConfig[serviceName].request)
      }
    })

    it('enabling requests with an additional filter', () => {
      process.env.DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING = '$.foo.bar'
      const taggingConfig = getConfig().cloudPayloadTagging
      assertObjectContains(taggingConfig, {
        requestsEnabled: true,
        responsesEnabled: false,
        maxDepth: 10,
      })
      const awsRules = taggingConfig.rules.aws
      for (const [, service] of Object.entries(awsRules)) {
        assertObjectContains(service, {
          request: ['$.foo.bar'],
        })
      }
    })

    it('enabling responses with no additional filter', () => {
      process.env.DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING = 'all'
      const taggingConfig = getConfig().cloudPayloadTagging
      assertObjectContains(taggingConfig, {
        requestsEnabled: false,
        responsesEnabled: true,
        maxDepth: 10,
      })
      const awsRules = taggingConfig.rules.aws
      for (const [serviceName, service] of Object.entries(awsRules)) {
        assert.deepStrictEqual(service.response, staticConfig[serviceName].response)
      }
    })

    it('enabling responses with an additional filter', () => {
      process.env.DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING = '$.foo.bar'
      const taggingConfig = getConfig().cloudPayloadTagging
      assertObjectContains(taggingConfig, {
        requestsEnabled: false,
        responsesEnabled: true,
        maxDepth: 10,
      })
      const awsRules = taggingConfig.rules.aws
      for (const [, service] of Object.entries(awsRules)) {
        assertObjectContains(service, {
          response: ['$.foo.bar'],
        })
      }
    })

    it('overriding max depth', () => {
      process.env.DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING = 'all'
      process.env.DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING = 'all'
      process.env.DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH = '7'

      let { cloudPayloadTagging } = getConfig()
      assertObjectContains(cloudPayloadTagging, {
        maxDepth: 7,
        requestsEnabled: true,
        responsesEnabled: true,
      })

      delete process.env.DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH

      ;({ cloudPayloadTagging } = getConfig({ cloudPayloadTagging: { maxDepth: 7 } }))
      assertObjectContains(cloudPayloadTagging, {
        maxDepth: 7,
        requestsEnabled: true,
        responsesEnabled: true,
      })
    })

    it('use default max depth if max depth is not a number', () => {
      process.env.DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH = 'abc'

      let { cloudPayloadTagging } = getConfig()
      assertObjectContains(cloudPayloadTagging, {
        maxDepth: 10,
      })

      delete process.env.DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH

      ;({ cloudPayloadTagging } = getConfig({ cloudPayloadTagging: { maxDepth: NaN } }))
      assertObjectContains(cloudPayloadTagging, {
        maxDepth: 10,
      })
    })
  })

  context('standalone', () => {
    it('should disable apm tracing with legacy DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED', () => {
      process.env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED = '1'

      const config = getConfig()
      assert.strictEqual(config.apmTracingEnabled, false)
    })

    it('should win DD_APM_TRACING_ENABLED', () => {
      process.env.DD_APM_TRACING_ENABLED = '1'
      process.env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED = 'true'

      const config = getConfig()
      assert.strictEqual(config.apmTracingEnabled, true)
    })

    it('should disable apm tracing with legacy experimental.appsec.standalone.enabled option', () => {
      process.env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED = '0'

      const config = getConfig({ experimental: { appsec: { standalone: { enabled: true } } } })
      assert.strictEqual(config.apmTracingEnabled, false)
    })

    it('should win apmTracingEnabled option', () => {
      process.env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED = 'true'

      const config = getConfig({
        apmTracingEnabled: false,
        experimental: { appsec: { standalone: { enabled: true } } },
      })
      assert.strictEqual(config.apmTracingEnabled, false)
    })

    it('should not affect stats', () => {
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED = 'true'

      const config = getConfig()
      assertObjectContains(config, {
        apmTracingEnabled: true,
        stats: {
          enabled: true,
        },
      })

      assertObjectContains(updateConfig.getCall(0).args[0], [
        { name: 'stats.enabled', value: true, origin: 'calculated' },
      ])
    })

    it('should disable stats', () => {
      process.env.DD_APM_TRACING_ENABLED = 'false'
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED = 'true'

      const config = getConfig()
      assertObjectContains(config, {
        apmTracingEnabled: false,
        stats: {
          enabled: false,
        },
      })

      assertObjectContains(updateConfig.getCall(0).args[0], [
        { name: 'stats.enabled', value: false, origin: 'calculated' },
      ])
    })

    it('should disable stats if config property is used', () => {
      const config = getConfig({
        apmTracingEnabled: false,
      })
      assertObjectContains(config, {
        apmTracingEnabled: false,
        stats: {
          enabled: false,
        },
      })
    })
  })

  context('library config', () => {
    // os.tmpdir() could return a falsy value on Windows, if process.env.TEMP or process.env.TMP are malformed.
    const baseTempDir = os.tmpdir() || 'C:\\Windows\\Temp'
    let env
    let tempDir
    let localConfigPath
    let fleetConfigPath

    beforeEach(() => {
      env = process.env
      tempDir = fs.mkdtempSync(path.join(baseTempDir, 'config-test-'))
      localConfigPath = path.join(tempDir, 'local.yaml')
      fleetConfigPath = path.join(tempDir, 'fleet.yaml')
      process.env.DD_TEST_LOCAL_CONFIG_PATH = localConfigPath
      process.env.DD_TEST_FLEET_CONFIG_PATH = fleetConfigPath
      reloadLoggerAndConfig()
    })

    afterEach(() => {
      process.env = env
      fs.rmSync(tempDir, { recursive: true })
    })

    it('should apply host wide config', () => {
      fs.writeFileSync(
        localConfigPath,
        `
apm_configuration_default:
  DD_RUNTIME_METRICS_ENABLED: 'true'
`)
      const config = getConfig()
      assert.strictEqual(config.runtimeMetrics?.enabled, true)
    })

    it('should apply service specific config', () => {
      fs.writeFileSync(
        localConfigPath,
        `
rules:
  - selectors:
    - origin: language
      matches:
        - nodejs
      operator: equals
    configuration:
      DD_SERVICE: my-service
`)
      const config = getConfig()
      assert.strictEqual(config.service, 'my-service')
    })

    it('should respect the priority sources', () => {
      // 1. Default
      const config1 = getConfig()
      assert.strictEqual(config1.service, 'node')

      // 2. Local stable > Default
      fs.writeFileSync(
        localConfigPath,
        `
rules:
  - selectors:
    - origin: language
      matches:
        - nodejs
      operator: equals
    configuration:
      DD_SERVICE: service_local_stable
`)
      const config2 = getConfig()
      assert.strictEqual(config2.service, 'service_local_stable')

      // 3. Env > Local stable > Default
      process.env.DD_SERVICE = 'service_env'
      const config3 = getConfig()
      assert.strictEqual(config3.service, 'service_env')

      // 4. Fleet Stable > Env > Local stable > Default
      fs.writeFileSync(
        fleetConfigPath,
        `
rules:
  - selectors:
    - origin: language
      matches:
        - nodejs
      operator: equals
    configuration:
      DD_SERVICE: service_fleet_stable
`)
      const config4 = getConfig()
      assert.strictEqual(config4?.service, 'service_fleet_stable')

      // 5. Code > Fleet Stable > Env > Local stable > Default
      const config5 = getConfig({ service: 'service_code' })
      assert.strictEqual(config5?.service, 'service_code')
    })

    it('should ignore unknown keys', () => {
      fs.writeFileSync(
        localConfigPath,
        `
apm_configuration_default:
  DD_RUNTIME_METRICS_ENABLED: 'true'
  DD_FOOBAR_ENABLED: baz
`)
      const stableConfig = new StableConfig()
      assert.strictEqual(stableConfig.warnings?.length, 0)

      const config = getConfig()
      assert.strictEqual(config.runtimeMetrics?.enabled, true)
    })

    it('should log a warning if the YAML files are malformed', () => {
      fs.writeFileSync(
        localConfigPath,
        `
    apm_configuration_default:
DD_RUNTIME_METRICS_ENABLED true
`)
      const stableConfig = new StableConfig()
      assert.strictEqual(stableConfig.warnings?.length, 1)
    })

    it('should only load the WASM module if the stable config files exist', () => {
      const stableConfig1 = new StableConfig()
      assert.strictEqual(stableConfig1?.wasm_loaded, false)

      fs.writeFileSync(
        localConfigPath,
        `
apm_configuration_default:
  DD_RUNTIME_METRICS_ENABLED: 'true'
`)
      const stableConfig2 = new StableConfig()
      assert.strictEqual(stableConfig2?.wasm_loaded, true)
    })

    it('should not load the WASM module in a serverless environment', () => {
      fs.writeFileSync(
        localConfigPath,
        `
apm_configuration_default:
  DD_RUNTIME_METRICS_ENABLED: 'true'
`)

      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-great-lambda-function'
      const stableConfig = getConfig()
      assert.ok(!(Object.hasOwn(stableConfig, 'stableConfig')))
    })

    it('should support all extended configs across product areas', () => {
      fs.writeFileSync(
        localConfigPath,
        `
apm_configuration_default:
  DD_TRACE_PROPAGATION_STYLE: "tracecontext"
  DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED: true

  DD_APPSEC_TRACE_RATE_LIMIT: '100'
  DD_APPSEC_MAX_STACK_TRACES: '2'
  DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP: "password|token"

  DD_IAST_REQUEST_SAMPLING: '50'
  DD_IAST_MAX_CONCURRENT_REQUESTS: '10'

  DD_TELEMETRY_HEARTBEAT_INTERVAL: '42'
  DD_TELEMETRY_METRICS_ENABLED: 'false'

  DD_LLMOBS_ML_APP: "my-llm-app"

  DD_PROFILING_EXPORTERS: "agent"

  DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE: "/tmp/probes"
`)
      const config = getConfig()

      // Tracing
      assert.strictEqual(config.traceId128BitGenerationEnabled, true)
      assert.deepStrictEqual(config.tracePropagationStyle?.inject, ['tracecontext'])
      assert.deepStrictEqual(config.tracePropagationStyle?.extract, ['tracecontext'])

      // Appsec
      assertObjectContains(config, {
        appsec: {
          rateLimit: 100,
          stackTrace: {
            maxStackTraces: 2,
          },
          obfuscatorKeyRegex: 'password|token',
        },
        iast: {
          requestSampling: 50,
          maxConcurrentRequests: 10,
        },
        telemetry: {
          heartbeatInterval: 42000,
          metrics: false,
        },
        llmobs: {
          mlApp: 'my-llm-app',
        },
        profiling: {
          exporters: 'agent',
        },
        dynamicInstrumentation: {
          probeFile: '/tmp/probes',
        },
      })
    })

    // Regression test for fields that were previously set directly from environment variables
    // before they were supported by stable config as well.
    it('should support legacy direct-set fields through all stable config and env var sources', () => {
      // Test 1: Local stable config should work
      fs.writeFileSync(
        localConfigPath,
        `
apm_configuration_default:
  DD_API_KEY: "local-api-key"
  DD_APP_KEY: "local-app-key"
  DD_INSTRUMENTATION_INSTALL_ID: "local-install-id"
  DD_INSTRUMENTATION_INSTALL_TIME: "1234567890"
  DD_INSTRUMENTATION_INSTALL_TYPE: "local_install"
  DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING: "all"
  DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH: '5'
`)
      let config = getConfig()
      assertObjectContains(config, {
        apiKey: 'local-api-key',
        appKey: 'local-app-key',
        installSignature: {
          id: 'local-install-id',
          time: '1234567890',
          type: 'local_install',
        },
        cloudPayloadTagging: {
          requestsEnabled: true,
          maxDepth: 5,
        },
      })

      // Test 2: Env vars should take precedence over local stable config
      process.env.DD_API_KEY = 'env-api-key'
      process.env.DD_APP_KEY = 'env-app-key'
      process.env.DD_INSTRUMENTATION_INSTALL_ID = 'env-install-id'
      process.env.DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH = '7'
      config = getConfig()
      assertObjectContains(config, {
        apiKey: 'env-api-key',
        appKey: 'env-app-key',
        installSignature: {
          id: 'env-install-id',
        },
        cloudPayloadTagging: {
          maxDepth: 7,
        },
      })

      // Test 3: Fleet stable config should take precedence over env vars
      fs.writeFileSync(
        fleetConfigPath,
        `
rules:
  - selectors:
    - origin: language
      matches:
        - nodejs
      operator: equals
    configuration:
      DD_API_KEY: "fleet-api-key"
      DD_APP_KEY: "fleet-app-key"
      DD_INSTRUMENTATION_INSTALL_ID: "fleet-install-id"
      DD_INSTRUMENTATION_INSTALL_TIME: "9999999999"
      DD_INSTRUMENTATION_INSTALL_TYPE: "fleet_install"
      DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING: ""
      DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING: "all"
      DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH: '15'
`)
      config = getConfig()
      assertObjectContains(config, {
        apiKey: 'fleet-api-key',
        appKey: 'fleet-app-key',
        installSignature: {
          id: 'fleet-install-id',
          time: '9999999999',
          type: 'fleet_install',
        },
        cloudPayloadTagging: {
          requestsEnabled: false,
          responsesEnabled: true,
          maxDepth: 15,
        },
      })
    })
  })

  context('resourceRenamingEnabled', () => {
    let originalResourceRenamingEnabled
    let originalAppsecEnabled

    beforeEach(() => {
      originalResourceRenamingEnabled = process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED
      originalAppsecEnabled = process.env.DD_APPSEC_ENABLED
      delete process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED
      delete process.env.DD_APPSEC_ENABLED
    })

    afterEach(() => {
      if (originalResourceRenamingEnabled !== undefined) {
        process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = originalResourceRenamingEnabled
      } else {
        delete process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED
      }
      if (originalAppsecEnabled !== undefined) {
        process.env.DD_APPSEC_ENABLED = originalAppsecEnabled
      } else {
        delete process.env.DD_APPSEC_ENABLED
      }
    })

    it('should be false by default', () => {
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should be enabled when DD_TRACE_RESOURCE_RENAMING_ENABLED is true', () => {
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should be disabled when DD_TRACE_RESOURCE_RENAMING_ENABLED is false', () => {
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should be enabled when appsec is enabled via env var', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should be enabled when appsec is enabled via options', () => {
      const config = getConfig({ appsec: { enabled: true } })
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should prioritize DD_TRACE_RESOURCE_RENAMING_ENABLED over appsec setting', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should prioritize DD_TRACE_RESOURCE_RENAMING_ENABLED over appsec option', () => {
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'false'
      const config = getConfig({ appsec: { enabled: true } })
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should enable when appsec is enabled via both env and options', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      const config = getConfig({ appsec: { enabled: true } })
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should remain false when appsec is disabled', () => {
      process.env.DD_APPSEC_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should remain false when appsec is disabled via options', () => {
      const config = getConfig({ appsec: { enabled: false } })
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })
  })

  context('NX auto-detection', () => {
    it('should use NX_TASK_TARGET_PROJECT when DD_ENABLE_NX_SERVICE_NAME is true or 1', () => {
      process.env.NX_TASK_TARGET_PROJECT = 'my-nx-project'

      for (const ddIsNx of ['true', '1']) {
        process.env.DD_ENABLE_NX_SERVICE_NAME = ddIsNx

        const config = getConfig()

        assert.strictEqual(config.service, 'my-nx-project')
      }
    })

    it('should give DD_SERVICE precedence over NX_TASK_TARGET_PROJECT', () => {
      process.env.DD_ENABLE_NX_SERVICE_NAME = 'true'
      process.env.DD_SERVICE = 'explicit-service'
      process.env.NX_TASK_TARGET_PROJECT = 'my-nx-project'

      const config = getConfig()

      assert.strictEqual(config.service, 'explicit-service')
    })

    it('should not use NX_TASK_TARGET_PROJECT when DD_ENABLE_NX_SERVICE_NAME is falsy', () => {
      const cases = ['false', '0', undefined]

      for (const ddIsNx of cases) {
        if (ddIsNx === undefined) {
          delete process.env.DD_ENABLE_NX_SERVICE_NAME
        } else {
          process.env.DD_ENABLE_NX_SERVICE_NAME = ddIsNx
        }

        process.env.NX_TASK_TARGET_PROJECT = 'my-nx-project'
        pkg.name = 'default-service'
        reloadLoggerAndConfig()

        const config = getConfig()

        assert.strictEqual(config.service, 'default-service')
        assert.notStrictEqual(config.service, 'my-nx-project')
      }
    })

    it('should fallback to default when NX_TASK_TARGET_PROJECT is empty or not set', () => {
      const cases = ['', undefined]

      for (const nxTaskTargetProject of cases) {
        process.env.DD_ENABLE_NX_SERVICE_NAME = 'true'

        if (nxTaskTargetProject === undefined) {
          delete process.env.NX_TASK_TARGET_PROJECT
        } else {
          process.env.NX_TASK_TARGET_PROJECT = nxTaskTargetProject
        }

        pkg.name = 'default-service'
        reloadLoggerAndConfig()

        const config = getConfig()

        assert.strictEqual(config.service, 'default-service')
      }
    })

    it('should warn about v6 behavior change when NX_TASK_TARGET_PROJECT is set without explicit config', () => {
      process.env.NX_TASK_TARGET_PROJECT = 'my-nx-project'
      delete process.env.DD_ENABLE_NX_SERVICE_NAME
      delete process.env.DD_SERVICE
      pkg.name = 'default-service'
      reloadLoggerAndConfig()

      getConfig()

      if (DD_MAJOR < 6) {
        assert.strictEqual(log.warn.called, true)
        const warningMessage = log.warn.args[0][0]
        assert.match(warningMessage, /NX_TASK_TARGET_PROJECT is set but no service name was configured/)
        assert.match(warningMessage, /In v6, NX_TASK_TARGET_PROJECT will be used as the default service name/)
        assert.match(warningMessage, /Set DD_ENABLE_NX_SERVICE_NAME=true to opt-in/)
      } else {
        // In v6+, no warning should be issued
        assert.strictEqual(log.warn.called, false)
      }
    })

    it('should not warn when DD_ENABLE_NX_SERVICE_NAME is explicitly set', () => {
      process.env.NX_TASK_TARGET_PROJECT = 'my-nx-project'
      process.env.DD_ENABLE_NX_SERVICE_NAME = 'true'
      delete process.env.DD_SERVICE
      pkg.name = 'default-service'
      reloadLoggerAndConfig()

      getConfig()

      assert.strictEqual(log.warn.called, false)
    })

    it('should not warn when a service name is explicitly configured', () => {
      process.env.NX_TASK_TARGET_PROJECT = 'my-nx-project'
      process.env.DD_SERVICE = 'explicit-service'
      delete process.env.DD_ENABLE_NX_SERVICE_NAME
      reloadLoggerAndConfig()

      getConfig()

      assert.strictEqual(log.warn.called, false)
    })
  })

  context('resourceRenamingEnabled', () => {
    let originalResourceRenamingEnabled
    let originalAppsecEnabled

    beforeEach(() => {
      originalResourceRenamingEnabled = process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED
      originalAppsecEnabled = process.env.DD_APPSEC_ENABLED
      delete process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED
      delete process.env.DD_APPSEC_ENABLED
    })

    afterEach(() => {
      if (originalResourceRenamingEnabled !== undefined) {
        process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = originalResourceRenamingEnabled
      } else {
        delete process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED
      }
      if (originalAppsecEnabled !== undefined) {
        process.env.DD_APPSEC_ENABLED = originalAppsecEnabled
      } else {
        delete process.env.DD_APPSEC_ENABLED
      }
    })

    it('should be false by default', () => {
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should be enabled when DD_TRACE_RESOURCE_RENAMING_ENABLED is true', () => {
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should be disabled when DD_TRACE_RESOURCE_RENAMING_ENABLED is false', () => {
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should be enabled when appsec is enabled via env var', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should be enabled when appsec is enabled via options', () => {
      const config = getConfig({ appsec: { enabled: true } })
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should prioritize DD_TRACE_RESOURCE_RENAMING_ENABLED over appsec setting', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should prioritize DD_TRACE_RESOURCE_RENAMING_ENABLED over appsec option', () => {
      process.env.DD_TRACE_RESOURCE_RENAMING_ENABLED = 'false'
      const config = getConfig({ appsec: { enabled: true } })
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should enable when appsec is enabled via both env and options', () => {
      process.env.DD_APPSEC_ENABLED = 'true'
      const config = getConfig({ appsec: { enabled: true } })
      assert.strictEqual(config.resourceRenamingEnabled, true)
    })

    it('should remain false when appsec is disabled', () => {
      process.env.DD_APPSEC_ENABLED = 'false'
      const config = getConfig()
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })

    it('should remain false when appsec is disabled via options', () => {
      const config = getConfig({ appsec: { enabled: false } })
      assert.strictEqual(config.resourceRenamingEnabled, false)
    })
  })

  context('getOrigin', () => {
    let originalAppsecEnabled

    beforeEach(() => {
      originalAppsecEnabled = process.env.DD_APPSEC_ENABLED
    })

    afterEach(() => {
      process.env.DD_APPSEC_ENABLED = originalAppsecEnabled
    })

    it('should return default value', () => {
      const config = getConfig()

      assert.strictEqual(config.getOrigin('appsec.enabled'), 'default')
    })

    it('should return env_var', () => {
      process.env.DD_APPSEC_ENABLED = 'true'

      const config = getConfig()

      assert.strictEqual(config.getOrigin('appsec.enabled'), 'env_var')
    })

    it('should return code', () => {
      const config = getConfig({
        appsec: true,
      })

      assert.strictEqual(config.getOrigin('appsec.enabled'), 'code')
    })
  })

  describe('remote config field mapping', () => {
    it('should map dynamic_instrumentation_enabled to dynamicInstrumentation.enabled', () => {
      const config = getConfig()
      assert.strictEqual(config.dynamicInstrumentation.enabled, false)
      config.setRemoteConfig({ dynamic_instrumentation_enabled: true })
      assert.strictEqual(config.dynamicInstrumentation.enabled, true)
    })

    it('should map code_origin_enabled to codeOriginForSpans.enabled', () => {
      const config = getConfig()
      assert.strictEqual(config.codeOriginForSpans.enabled, true)
      config.setRemoteConfig({ code_origin_enabled: false })
      assert.strictEqual(config.codeOriginForSpans.enabled, false)
    })

    it('should map tracing_sampling_rate to sampleRate', () => {
      const config = getConfig()
      assert.strictEqual(config.sampleRate, undefined)
      config.setRemoteConfig({ tracing_sampling_rate: 0.5 })
      assert.strictEqual(config.sampleRate, 0.5)
    })

    it('should map log_injection_enabled to logInjection', () => {
      const config = getConfig()
      assert.strictEqual(config.logInjection, true)
      config.setRemoteConfig({ log_injection_enabled: false })
      assert.strictEqual(config.logInjection, false)
    })

    it('should map tracing_enabled to tracing', () => {
      const config = getConfig()
      assert.strictEqual(config.tracing, true)
      config.setRemoteConfig({ tracing_enabled: false })
      assert.strictEqual(config.tracing, false)
    })

    it('should map tracing_sampling_rules to sampler.rules', () => {
      const config = getConfig()
      assert.deepStrictEqual(config.sampler.rules, [])
      config.setRemoteConfig({ tracing_sampling_rules: [{ sample_rate: 0.5 }] })
      assert.deepStrictEqual(config.sampler.rules, [{ sampleRate: 0.5 }])
    })

    it('should map tracing_header_tags to headerTags', () => {
      const config = getConfig({ headerTags: ['foo:bar'] })
      assert.deepStrictEqual(config.headerTags, ['foo:bar'])
      config.setRemoteConfig({ tracing_header_tags: [{ header: 'x-custom-header', tag_name: 'custom.tag' }] })
      assert.deepStrictEqual(config.headerTags, [
        // TODO: There's an unrelated bug in the tracer resulting in headerTags not being merged.
        // 'foo:bar',
        'x-custom-header:custom.tag',
      ])
    })

    it('should map tracing_tags to tags', () => {
      const config = getConfig({ tags: { foo: 'bar' } })
      assertObjectContains(config.tags, { foo: 'bar' })
      assert.strictEqual(config.tags.team, undefined)
      config.setRemoteConfig({ tracing_tags: ['team:backend'] })
      assertObjectContains(config.tags, {
        // TODO: There's an unrelated bug in the tracer resulting in tags not being merged.
        // foo: 'bar',
        team: 'backend',
      })
    })
  })

  describe('remote config application', () => {
    it('should clear RC fields when setRemoteConfig is called with null', () => {
      const config = getConfig({ logInjection: true, sampleRate: 0.5 })

      config.setRemoteConfig({ tracing_enabled: false })

      assert.strictEqual(config.tracing, false)
      assert.strictEqual(config.logInjection, true)
      assert.strictEqual(config.sampleRate, 0.5)

      config.setRemoteConfig(null)

      assert.strictEqual(config.tracing, true)
      assert.strictEqual(config.logInjection, true)
      assert.strictEqual(config.sampleRate, 0.5)
    })

    it('should ignore null values', () => {
      const config = getConfig({ sampleRate: 0.5 })
      config.setRemoteConfig({ tracing_sampling_rate: null })
      assert.strictEqual(config.sampleRate, 0.5)
    })

    it('should treat null values as unset', () => {
      const config = getConfig({ sampleRate: 0.5 })
      config.setRemoteConfig({ tracing_sampling_rate: 0.8 })
      assert.strictEqual(config.sampleRate, 0.8)
      config.setRemoteConfig({ tracing_sampling_rate: null })
      assert.strictEqual(config.sampleRate, 0.5)
    })

    it('should replace all RC fields with each update', () => {
      const config = getConfig()

      config.setRemoteConfig({
        tracing_enabled: true,
        log_injection_enabled: false,
        tracing_sampling_rate: 0.8,
      })

      assert.strictEqual(config.tracing, true)
      assert.strictEqual(config.logInjection, false)
      assert.strictEqual(config.sampleRate, 0.8)

      config.setRemoteConfig({
        tracing_enabled: false,
      })

      assert.strictEqual(config.tracing, false)
      assert.strictEqual(config.logInjection, true)
      assert.strictEqual(config.sampleRate, undefined)
    })
  })

  context('agentless APM span intake', () => {
    it('should not enable agentless exporter by default', () => {
      const config = getConfig()
      assert.notStrictEqual(config.experimental.exporter, 'agentless')
    })

    it('should enable agentless exporter when _DD_APM_TRACING_AGENTLESS_ENABLED is true', () => {
      process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.experimental.exporter, 'agentless')
    })

    it('should disable rate limiting when agentless is enabled', () => {
      process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.sampler.rateLimit, -1)
    })

    it('should disable stats computation when agentless is enabled', () => {
      process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.stats.enabled, false)
    })

    it('should enable hostname reporting when agentless is enabled', () => {
      process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'true'
      const config = getConfig()
      assert.strictEqual(config.reportHostname, true)
    })

    it('should clear sampling rules when agentless is enabled', () => {
      process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'true'
      const config = getConfig()
      assert.deepStrictEqual(config.sampler.rules, [])
    })

    it('should not affect other config when agentless is disabled', () => {
      process.env._DD_APM_TRACING_AGENTLESS_ENABLED = 'false'
      const config = getConfig()
      assert.notStrictEqual(config.experimental.exporter, 'agentless')
      assert.notStrictEqual(config.sampler.rateLimit, -1)
    })
  })
})
