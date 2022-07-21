'use strict'

const { expect } = require('chai')

const path = require('path')

describe('Config', () => {
  let Config
  let pkg
  let env
  let fs
  let os
  let existsSyncParam
  let existsSyncReturn
  let osType

  beforeEach(() => {
    pkg = {
      name: '',
      version: ''
    }

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
      fs,
      os
    })
  })

  afterEach(() => {
    process.env = env
    existsSyncParam = undefined
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
    expect(config).to.have.property('queryStringObfuscation').with.length(625)
    expect(config).to.have.property('sampleRate', 1)
    expect(config).to.have.property('runtimeMetrics', false)
    expect(config.tags).to.have.property('service', 'node')
    expect(config).to.have.property('plugins', true)
    expect(config).to.have.property('env', undefined)
    expect(config).to.have.property('reportHostname', false)
    expect(config).to.have.property('scope', undefined)
    expect(config).to.have.property('logLevel', 'debug')
    expect(config).to.have.nested.property('experimental.b3', false)
    expect(config).to.have.nested.property('experimental.traceparent', false)
    expect(config).to.have.nested.property('experimental.runtimeId', false)
    expect(config).to.have.nested.property('experimental.exporter', undefined)
    expect(config).to.have.nested.property('experimental.enableGetRumData', false)
    expect(config).to.have.nested.property('appsec.enabled', false)
    const rulePath = path.join(__dirname, '..', 'src', 'appsec', 'recommended.json')
    expect(config).to.have.nested.property('appsec.rules', rulePath)
    expect(config).to.have.nested.property('appsec.rateLimit', 100)
    expect(config).to.have.nested.property('appsec.wafTimeout', 5e3)
    expect(config).to.have.nested.property('appsec.obfuscatorKeyRegex').with.length(155)
    expect(config).to.have.nested.property('appsec.obfuscatorValueRegex').with.length(443)
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
    process.env.DD_VERSION = '1.0.0'
    process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = '.*'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
    process.env.DD_ENV = 'test'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:bar,baz:qux'
    process.env.DD_TRACE_SAMPLE_RATE = '0.5'
    process.env.DD_TRACE_RATE_LIMIT = '-1'
    process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_TRACEPARENT_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'log'
    process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_INTERNAL_ERRORS_ENABLED = 'true'
    process.env.DD_APPSEC_ENABLED = 'true'
    process.env.DD_APPSEC_RULES = './path/rules.json'
    process.env.DD_APPSEC_TRACE_RATE_LIMIT = '42'
    process.env.DD_APPSEC_WAF_TIMEOUT = '42'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = '.*'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = '.*'

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
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config).to.have.property('reportHostname', true)
    expect(config).to.have.property('env', 'test')
    expect(config).to.have.property('sampleRate', 0.5)
    expect(config.tags).to.include({ foo: 'bar', baz: 'qux' })
    expect(config.tags).to.include({ service: 'service', 'version': '1.0.0', 'env': 'test' })
    expect(config).to.have.deep.nested.property('experimental.sampler', { sampleRate: '0.5', rateLimit: '-1' })
    expect(config).to.have.nested.property('experimental.b3', true)
    expect(config).to.have.nested.property('experimental.traceparent', true)
    expect(config).to.have.nested.property('experimental.runtimeId', true)
    expect(config).to.have.nested.property('experimental.exporter', 'log')
    expect(config).to.have.nested.property('experimental.enableGetRumData', true)
    expect(config).to.have.nested.property('appsec.enabled', true)
    expect(config).to.have.nested.property('appsec.rules', './path/rules.json')
    expect(config).to.have.nested.property('appsec.rateLimit', 42)
    expect(config).to.have.nested.property('appsec.wafTimeout', 42)
    expect(config).to.have.nested.property('appsec.obfuscatorKeyRegex', '.*')
    expect(config).to.have.nested.property('appsec.obfuscatorValueRegex', '.*')
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

  it('should initialize from the options', () => {
    const logger = {}
    const tags = {
      'foo': 'bar'
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
      sampleRate: 0.5,
      logger,
      tags,
      flushInterval: 5000,
      flushMinSpans: 500,
      runtimeMetrics: true,
      reportHostname: true,
      plugins: false,
      logLevel: logLevel,
      experimental: {
        b3: true,
        traceparent: true,
        runtimeId: true,
        exporter: 'log',
        enableGetRumData: true,
        sampler: {
          sampleRate: 1,
          rateLimit: 1000
        }
      },
      appsec: true
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
    expect(config).to.have.property('flushInterval', 5000)
    expect(config).to.have.property('flushMinSpans', 500)
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config).to.have.property('reportHostname', true)
    expect(config).to.have.property('plugins', false)
    expect(config).to.have.property('logLevel', logLevel)
    expect(config).to.have.property('tags')
    expect(config.tags).to.have.property('foo', 'bar')
    expect(config.tags).to.have.property('runtime-id')
    expect(config.tags['runtime-id']).to.match(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    expect(config).to.have.nested.property('experimental.b3', true)
    expect(config).to.have.nested.property('experimental.traceparent', true)
    expect(config).to.have.nested.property('experimental.runtimeId', true)
    expect(config).to.have.nested.property('experimental.exporter', 'log')
    expect(config).to.have.nested.property('experimental.enableGetRumData', true)
    expect(config).to.have.nested.property('appsec.enabled', true)
    expect(config).to.have.deep.nested.property('experimental.sampler', { sampleRate: 0.5, rateLimit: 1000 })
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
    process.env.DD_VERSION = '0.0.0'
    process.env.DD_RUNTIME_METRICS_ENABLED = 'true'
    process.env.DD_TRACE_REPORT_HOSTNAME = 'true'
    process.env.DD_ENV = 'test'
    process.env.DD_API_KEY = '123'
    process.env.DD_APP_KEY = '456'
    process.env.DD_TRACE_GLOBAL_TAGS = 'foo:bar,baz:qux'
    process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_TRACEPARENT_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'log'
    process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED = 'true'
    process.env.DD_TRACE_EXPERIMENTAL_INTERNAL_ERRORS_ENABLED = 'true'
    process.env.DD_APPSEC_ENABLED = 'false'
    process.env.DD_APPSEC_RULES = 'something'
    process.env.DD_APPSEC_TRACE_RATE_LIMIT = 11
    process.env.DD_APPSEC_WAF_TIMEOUT = 11
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = '^$'
    process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = '^$'

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
      tags: {
        foo: 'foo'
      },
      experimental: {
        b3: false,
        traceparent: false,
        runtimeId: false,
        exporter: 'agent',
        enableGetRumData: false
      },
      appsec: {
        enabled: true,
        rules: './path/rules.json',
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*'
      }
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
    expect(config.tags).to.include({ foo: 'foo', baz: 'qux' })
    expect(config.tags).to.include({ service: 'test', version: '1.0.0', env: 'development' })
    expect(config).to.have.nested.property('experimental.b3', false)
    expect(config).to.have.nested.property('experimental.traceparent', false)
    expect(config).to.have.nested.property('experimental.runtimeId', false)
    expect(config).to.have.nested.property('experimental.exporter', 'agent')
    expect(config).to.have.nested.property('experimental.enableGetRumData', false)
    expect(config).to.have.nested.property('appsec.enabled', true)
    expect(config).to.have.nested.property('appsec.rules', './path/rules.json')
    expect(config).to.have.nested.property('appsec.rateLimit', 42)
    expect(config).to.have.nested.property('appsec.wafTimeout', 42)
    expect(config).to.have.nested.property('appsec.obfuscatorKeyRegex', '.*')
    expect(config).to.have.nested.property('appsec.obfuscatorValueRegex', '.*')
  })

  it('should give priority to non-experimental options', () => {
    const config = new Config({
      ingestion: {
        sampleRate: 0.5,
        rateLimit: 500
      },
      appsec: {
        enabled: true,
        rules: './path/rules.json',
        rateLimit: 42,
        wafTimeout: 42,
        obfuscatorKeyRegex: '.*',
        obfuscatorValueRegex: '.*'
      },
      experimental: {
        sampler: {
          sampleRate: 0.1,
          rateLimit: 100
        },
        appsec: {
          enabled: false,
          rules: 'something',
          rateLimit: 11,
          wafTimeout: 11,
          obfuscatorKeyRegex: '^$',
          obfuscatorValueRegex: '^$'
        }
      }
    })

    expect(config).to.have.deep.nested.property('experimental.sampler', {
      sampleRate: 0.5, rateLimit: 500
    })
    expect(config).to.have.deep.property('appsec', {
      enabled: true,
      rules: './path/rules.json',
      rateLimit: 42,
      wafTimeout: 42,
      obfuscatorKeyRegex: '.*',
      obfuscatorValueRegex: '.*'
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
    expect(new Config({ sampleRate: NaN })).to.have.property('sampleRate', 1)
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

  it('should support the serviceMapping environment variable', () => {
    let origVar
    if ('DD_SERVICE_MAPPING' in process.env) {
      origVar = Object.getOwnPropertyDescriptor(process.env, 'DD_SERVICE')
    }
    process.env.DD_SERVICE_MAPPING = 'a:aa, b:bb'
    let config = new Config()

    expect(config.serviceMapping).to.deep.equal({
      a: 'aa',
      b: 'bb'
    })

    if (origVar) {
      Object.defineProperty(process.env, 'DD_SERVICE', origVar)
    } else {
      delete process.env.DD_SERVICE_MAPPING
    }

    config = new Config()

    expect(config.serviceMapping).to.deep.equal({})
  })

  it('should trim whitespace characters around keys', () => {
    process.env.DD_TAGS = 'foo:bar, baz:qux'

    const config = new Config()

    expect(config.tags).to.include({ foo: 'bar', baz: 'qux' })
  })

  it('should not set DD_TRACE_TELEMETRY_ENABLED if AWS_LAMBDA_FUNCTION_NAME is present', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-great-lambda-function'

    const config = new Config()

    expect(config.telemetryEnabled).to.be.false
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
})
