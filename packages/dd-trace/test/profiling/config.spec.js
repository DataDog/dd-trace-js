'use strict'

const { expect } = require('chai')
const os = require('os')
const { AgentExporter } = require('../../src/profiling/exporters/agent')
const { InspectorCpuProfiler } = require('../../src/profiling/profilers/inspector/cpu')
const { InspectorHeapProfiler } = require('../../src/profiling/profilers/inspector/heap')
const { ConsoleLogger } = require('../../src/profiling/loggers/console')

describe('config', () => {
  let Config

  beforeEach(() => {
    Config = require('../../src/profiling/config').Config
  })

  it('should have the correct defaults', () => {
    const config = new Config()

    expect(config).to.deep.include({
      enabled: true,
      service: 'node',
      flushInterval: 60 * 1000
    })

    expect(config.tags).to.deep.equal({
      service: 'node',
      host: os.hostname()
    })

    expect(config.logger).to.be.an.instanceof(ConsoleLogger)
    expect(config.exporters[0]).to.be.an.instanceof(AgentExporter)
    expect(config.profilers[0]).to.be.an.instanceof(InspectorCpuProfiler)
    expect(config.profilers[1]).to.be.an.instanceof(InspectorHeapProfiler)
  })

  it('should support configuration options', () => {
    const options = {
      enabled: false,
      service: 'test',
      version: '1.2.3-test.0',
      logger: {
        debug () {},
        info () {},
        warn () {},
        error () {}
      },
      exporters: ['agent'],
      profilers: [new InspectorCpuProfiler()],
      url: 'http://localhost:1234/'
    }

    const config = new Config(options)

    expect(config.enabled).to.equal(options.enabled)
    expect(config.service).to.equal(options.service)
    expect(config.host).to.be.a('string')
    expect(config.version).to.equal(options.version)
    expect(config.tags).to.be.an('object')
    expect(config.tags.host).to.be.a('string')
    expect(config.tags.service).to.equal(options.service)
    expect(config.tags.version).to.equal(options.version)
    expect(config.flushInterval).to.equal(60 * 1000)
    expect(config.exporters).to.be.an('array')
    expect(config.exporters.length).to.equal(1)
    expect(config.exporters[0]._url.toString()).to.equal(options.url)
    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(InspectorCpuProfiler)
  })

  it('should support tags', () => {
    const tags = {
      env: 'dev'
    }

    const config = new Config({ tags })

    expect(config.tags).to.include(tags)
  })

  it('should prioritize options over tags', () => {
    const env = 'prod'
    const service = 'foo'
    const version = '1.2.3'
    const tags = {
      env: 'dev',
      service: 'bar',
      version: '3.2.1'
    }

    const config = new Config({ env, service, version, tags })

    expect(config.tags).to.include({ env, service, version })
  })
})
