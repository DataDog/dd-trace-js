'use strict'

describe('Config', () => {
  let Config
  let platform

  beforeEach(() => {
    platform = {
      env: sinon.stub(),
      service: sinon.stub(),
      appVersion: sinon.stub()
    }

    Config = proxyquire('../src/config', {
      './platform': platform
    })
  })

  it('should initialize with the correct defaults', () => {
    const config = new Config()

    expect(config).to.have.property('service', 'node')
    expect(config).to.have.property('enabled', true)
    expect(config).to.have.property('debug', false)
    expect(config).to.have.nested.property('dogstatsd.hostname', '127.0.0.1')
    expect(config).to.have.nested.property('dogstatsd.port', '8125')
    expect(config).to.have.property('flushInterval', 2000)
    expect(config).to.have.property('sampleRate', 1)
    expect(config).to.have.property('runtimeMetrics', false)
    expect(config).to.have.property('trackAsyncScope', true)
    expect(config.tags).to.have.property('service', 'node')
    expect(config).to.have.property('plugins', true)
    expect(config).to.have.property('env', undefined)
    expect(config).to.have.property('reportHostname', false)
    expect(config).to.have.property('scope', undefined)
    expect(config).to.have.property('clientToken', undefined)
    expect(config).to.have.property('logLevel', 'debug')
    expect(config).to.have.nested.property('experimental.b3', false)
  })

  it('should initialize from the default service', () => {
    platform.service.returns('test')

    const config = new Config()

    expect(config).to.have.property('service', 'test')
    expect(config.tags).to.have.property('service', 'test')
  })

  it('should initialize from the default version', () => {
    platform.appVersion.returns('1.2.3')

    const config = new Config()

    expect(config).to.have.property('version', '1.2.3')
    expect(config.tags).to.have.property('version', '1.2.3')
  })

  it('should initialize from environment variables', () => {
    platform.env.withArgs('DD_TRACE_AGENT_HOSTNAME').returns('agent')
    platform.env.withArgs('DD_TRACE_AGENT_PORT').returns('6218')
    platform.env.withArgs('DD_DOGSTATSD_HOSTNAME').returns('dsd-agent')
    platform.env.withArgs('DD_DOGSTATSD_PORT').returns('5218')
    platform.env.withArgs('DD_TRACE_ENABLED').returns('false')
    platform.env.withArgs('DD_TRACE_DEBUG').returns('true')
    platform.env.withArgs('DD_TRACE_ANALYTICS').returns('true')
    platform.env.withArgs('DD_SERVICE').returns('service')
    platform.env.withArgs('DD_VERSION').returns('1.0.0')
    platform.env.withArgs('DD_RUNTIME_METRICS_ENABLED').returns('true')
    platform.env.withArgs('DD_TRACE_REPORT_HOSTNAME').returns('true')
    platform.env.withArgs('DD_ENV').returns('test')
    platform.env.withArgs('DD_CLIENT_TOKEN').returns('789')
    platform.env.withArgs('DD_TRACE_GLOBAL_TAGS').returns('foo:bar,baz:qux')
    platform.env.withArgs('DD_TRACE_SAMPLE_RATE').returns('0.5')
    platform.env.withArgs('DD_TRACE_RATE_LIMIT').returns('-1')

    const config = new Config()

    expect(config).to.have.property('enabled', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.property('analytics', true)
    expect(config).to.have.property('hostname', 'agent')
    expect(config).to.have.nested.property('dogstatsd.hostname', 'dsd-agent')
    expect(config).to.have.nested.property('dogstatsd.port', '5218')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('version', '1.0.0')
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config).to.have.property('reportHostname', true)
    expect(config).to.have.property('env', 'test')
    expect(config).to.have.property('clientToken', '789')
    expect(config.tags).to.include({ foo: 'bar', baz: 'qux' })
    expect(config.tags).to.include({ service: 'service', 'version': '1.0.0', 'env': 'test' })
    expect(config).to.have.deep.nested.property('experimental.sampler', { sampleRate: '0.5', rateLimit: '-1' })
  })

  it('should read case-insensitive booleans from environment variables', () => {
    platform.env.withArgs('DD_TRACE_ENABLED').returns('False')
    platform.env.withArgs('DD_TRACE_DEBUG').returns('TRUE')
    platform.env.withArgs('DD_TRACE_ANALYTICS').returns('1')
    platform.env.withArgs('DD_RUNTIME_METRICS_ENABLED').returns('0')

    const config = new Config()

    expect(config).to.have.property('enabled', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.property('analytics', true)
    expect(config).to.have.property('runtimeMetrics', false)
  })

  it('should initialize from environment variables with url taking precedence', () => {
    platform.env.withArgs('DD_TRACE_AGENT_URL').returns('https://agent2:7777')
    platform.env.withArgs('DD_SITE').returns('datadoghq.eu')
    platform.env.withArgs('DD_TRACE_AGENT_HOSTNAME').returns('agent')
    platform.env.withArgs('DD_TRACE_AGENT_PORT').returns('6218')
    platform.env.withArgs('DD_TRACE_ENABLED').returns('false')
    platform.env.withArgs('DD_TRACE_DEBUG').returns('true')
    platform.env.withArgs('DD_SERVICE').returns('service')
    platform.env.withArgs('DD_ENV').returns('test')

    const config = new Config()

    expect(config).to.have.property('enabled', false)
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
      analytics: true,
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
      runtimeMetrics: true,
      trackAsyncScope: false,
      reportHostname: true,
      plugins: false,
      scope: 'noop',
      clientToken: '789',
      logLevel: logLevel,
      experimental: {
        b3: true,
        runtimeId: true,
        sampler: {
          sampleRate: 1,
          rateLimit: 1000
        }
      }
    })

    expect(config).to.have.property('enabled', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.property('analytics', true)
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
    expect(config).to.have.property('runtimeMetrics', true)
    expect(config).to.have.property('trackAsyncScope', false)
    expect(config).to.have.property('reportHostname', true)
    expect(config).to.have.property('plugins', false)
    expect(config).to.have.property('scope', 'noop')
    expect(config).to.have.property('clientToken', '789')
    expect(config).to.have.property('logLevel', logLevel)
    expect(config).to.have.property('tags')
    expect(config.tags).to.have.property('foo', 'bar')
    expect(config.tags).to.have.property('runtime-id')
    expect(config.tags['runtime-id']).to.match(/^[0-9a-f]{32}$/)
    expect(config).to.have.nested.property('experimental.b3', true)
    expect(config).to.have.nested.property('experimental.runtimeId', true)
    expect(config).to.have.deep.nested.property('experimental.sampler', { sampleRate: 1, rateLimit: 1000 })
  })

  it('should initialize from the options with url taking precedence', () => {
    const logger = {}
    const tags = { foo: 'bar' }
    const config = new Config({
      enabled: false,
      debug: true,
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
      plugins: false
    })

    expect(config).to.have.property('enabled', false)
    expect(config).to.have.property('debug', true)
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
    expect(config).to.have.property('plugins', false)
  })

  it('should give priority to the common agent environment variable', () => {
    platform.env.withArgs('DD_TRACE_AGENT_HOSTNAME').returns('trace-agent')
    platform.env.withArgs('DD_AGENT_HOST').returns('agent')
    platform.env.withArgs('DD_TRACE_GLOBAL_TAGS').returns('foo:foo')
    platform.env.withArgs('DD_TAGS').returns('foo:bar,baz:qux')

    const config = new Config()

    expect(config).to.have.property('hostname', 'agent')
    expect(config.tags).to.include({ foo: 'foo', baz: 'qux' })
  })

  it('should give priority to the options', () => {
    platform.env.withArgs('DD_TRACE_AGENT_URL').returns('https://agent2:6218')
    platform.env.withArgs('DD_SITE').returns('datadoghq.eu')
    platform.env.withArgs('DD_TRACE_AGENT_HOSTNAME').returns('agent')
    platform.env.withArgs('DD_TRACE_AGENT_PORT').returns('6218')
    platform.env.withArgs('DD_DOGSTATSD_PORT').returns('5218')
    platform.env.withArgs('DD_TRACE_ENABLED').returns('false')
    platform.env.withArgs('DD_TRACE_DEBUG').returns('true')
    platform.env.withArgs('DD_TRACE_ANALYTICS').returns('true')
    platform.env.withArgs('DD_SERVICE').returns('service')
    platform.env.withArgs('DD_VERSION').returns('0.0.0')
    platform.env.withArgs('DD_RUNTIME_METRICS_ENABLED').returns('true')
    platform.env.withArgs('DD_TRACE_REPORT_HOSTNAME').returns('true')
    platform.env.withArgs('DD_ENV').returns('test')
    platform.env.withArgs('DD_API_KEY').returns('123')
    platform.env.withArgs('DD_APP_KEY').returns('456')
    platform.env.withArgs('DD_TRACE_GLOBAL_TAGS').returns('foo:bar,baz:qux')

    const config = new Config({
      enabled: true,
      debug: false,
      analytics: false,
      protocol: 'https',
      site: 'datadoghq.com',
      hostname: 'server',
      port: 7777,
      dogstatsd: {
        port: 8888
      },
      runtimeMetrics: false,
      reportHostname: false,
      service: 'test',
      version: '1.0.0',
      env: 'development',
      clientToken: '789',
      tags: {
        foo: 'foo'
      }
    })

    expect(config).to.have.property('enabled', true)
    expect(config).to.have.property('debug', false)
    expect(config).to.have.property('analytics', false)
    expect(config).to.have.nested.property('url.protocol', 'https:')
    expect(config).to.have.nested.property('url.hostname', 'agent2')
    expect(config).to.have.nested.property('url.port', '6218')
    expect(config).to.have.nested.property('dogstatsd.hostname', 'server')
    expect(config).to.have.nested.property('dogstatsd.port', '8888')
    expect(config).to.have.property('site', 'datadoghq.com')
    expect(config).to.have.property('runtimeMetrics', false)
    expect(config).to.have.property('reportHostname', false)
    expect(config).to.have.property('service', 'test')
    expect(config).to.have.property('version', '1.0.0')
    expect(config).to.have.property('env', 'development')
    expect(config).to.have.property('clientToken', '789')
    expect(config.tags).to.include({ foo: 'foo', baz: 'qux' })
    expect(config.tags).to.include({ service: 'test', version: '1.0.0', env: 'development' })
  })

  it('should give priority to the options especially url', () => {
    platform.env.withArgs('DD_TRACE_AGENT_URL').returns('http://agent2:6218')
    platform.env.withArgs('DD_TRACE_AGENT_HOSTNAME').returns('agent')
    platform.env.withArgs('DD_TRACE_AGENT_PORT').returns('6218')
    platform.env.withArgs('DD_TRACE_ENABLED').returns('false')
    platform.env.withArgs('DD_TRACE_DEBUG').returns('true')
    platform.env.withArgs('DD_SERVICE_NAME').returns('service')
    platform.env.withArgs('DD_ENV').returns('test')

    const config = new Config({
      enabled: true,
      debug: false,
      url: 'https://agent3:7778',
      protocol: 'http',
      hostname: 'server',
      port: 7777,
      service: 'test',
      env: 'development'
    })

    expect(config).to.have.property('enabled', true)
    expect(config).to.have.property('debug', false)
    expect(config).to.have.nested.property('url.protocol', 'https:')
    expect(config).to.have.nested.property('url.hostname', 'agent3')
    expect(config).to.have.nested.property('url.port', '7778')
    expect(config).to.have.property('service', 'test')
    expect(config).to.have.property('env', 'development')
  })

  it('should give priority to individual options over tags', () => {
    platform.env.withArgs('DD_SERVICE').returns('test')
    platform.env.withArgs('DD_ENV').returns('dev')
    platform.env.withArgs('DD_VERSION').returns('1.0.0')
    platform.env.withArgs('DD_TAGS', 'service=foo,env=bar,version=0.0.0')

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
    platform.env.withArgs('DD_SERVICE').returns('')

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
})
