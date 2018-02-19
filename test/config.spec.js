'use strict'

describe('Config', () => {
  let Config

  beforeEach(() => {
    delete process.env.DATADOG_TRACE_AGENT_HOSTNAME
    delete process.env.DATADOG_TRACE_AGENT_PORT
    delete process.env.DATADOG_TRACE_ENABLED
    delete process.env.DATADOG_TRACE_DEBUG
    delete process.env.DATADOG_SERVICE_NAME
    delete process.env.DATADOG_ENV

    Config = require('../src/config')
  })

  it('should initialize with the correct defaults', () => {
    const config = new Config()

    expect(config).to.have.property('enabled', true)
    expect(config).to.have.property('debug', false)
    expect(config).to.have.nested.property('url.protocol', 'http:')
    expect(config).to.have.nested.property('url.hostname', 'localhost')
    expect(config).to.have.nested.property('url.port', '8126')
    expect(config).to.have.property('flushInterval', 2000)
    expect(config).to.have.property('bufferSize', 1000)
    expect(config).to.have.property('sampleRate', 1)
    expect(config).to.have.deep.property('tags', {})
  })

  it('should initialize from environment variables', () => {
    process.env.DATADOG_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DATADOG_TRACE_AGENT_PORT = '6218'
    process.env.DATADOG_TRACE_ENABLED = 'false'
    process.env.DATADOG_TRACE_DEBUG = 'true'
    process.env.DATADOG_SERVICE_NAME = 'service'
    process.env.DATADOG_ENV = 'test'

    const config = new Config()

    expect(config).to.have.property('enabled', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.nested.property('url.hostname', 'agent')
    expect(config).to.have.nested.property('url.port', '6218')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('env', 'test')
  })

  it('should initialize from the options', () => {
    const logger = {}
    const tags = { foo: 'bar' }
    const config = new Config({
      enabled: false,
      debug: true,
      hostname: 'agent',
      port: 6218,
      service: 'service',
      env: 'test',
      logger,
      tags
    })

    expect(config).to.have.property('enabled', false)
    expect(config).to.have.property('debug', true)
    expect(config).to.have.nested.property('url.hostname', 'agent')
    expect(config).to.have.nested.property('url.port', '6218')
    expect(config).to.have.property('service', 'service')
    expect(config).to.have.property('env', 'test')
    expect(config).to.have.property('logger', logger)
    expect(config).to.have.deep.property('tags', tags)
  })

  it('should give priority to the options', () => {
    process.env.DATADOG_TRACE_AGENT_HOSTNAME = 'agent'
    process.env.DATADOG_TRACE_AGENT_PORT = '6218'
    process.env.DATADOG_TRACE_ENABLED = 'false'
    process.env.DATADOG_TRACE_DEBUG = 'true'
    process.env.DATADOG_SERVICE_NAME = 'service'
    process.env.DATADOG_ENV = 'test'

    const config = new Config({
      enabled: true,
      debug: false,
      hostname: 'server',
      port: 7777,
      service: 'test',
      env: 'development'
    })

    expect(config).to.have.property('enabled', true)
    expect(config).to.have.property('debug', false)
    expect(config).to.have.nested.property('url.hostname', 'server')
    expect(config).to.have.nested.property('url.port', '7777')
    expect(config).to.have.property('service', 'test')
    expect(config).to.have.property('env', 'development')
  })
})
