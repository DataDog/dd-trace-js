'use strict'

require('../setup/tap')

const { expect } = require('chai')
const os = require('os')
const path = require('path')
const { AgentExporter } = require('../../src/profiling/exporters/agent')
const { FileExporter } = require('../../src/profiling/exporters/file')
const WallProfiler = require('../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../src/profiling/profilers/space')
const { ConsoleLogger } = require('../../src/profiling/loggers/console')

describe('config', () => {
  let Config
  let env
  const nullLogger = {
    debug () { },
    info () { },
    warn () { },
    error () { }
  }

  beforeEach(() => {
    Config = require('../../src/profiling/config').Config
    env = process.env
    process.env = {}
  })

  afterEach(() => {
    process.env = env
  })

  it('should have the correct defaults', () => {
    const config = new Config()

    expect(config).to.deep.include({
      enabled: true,
      service: 'node',
      flushInterval: 65 * 1000
    })

    expect(config.tags).to.deep.equal({
      service: 'node',
      host: os.hostname()
    })

    expect(config.logger).to.be.an.instanceof(ConsoleLogger)
    expect(config.exporters[0]).to.be.an.instanceof(AgentExporter)
    expect(config.profilers[0]).to.be.an.instanceof(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).false
    expect(config.profilers[1]).to.be.an.instanceof(SpaceProfiler)
    expect(config.v8ProfilerBugWorkaroundEnabled).true
  })

  it('should support configuration options', () => {
    const options = {
      enabled: false,
      service: 'test',
      version: '1.2.3-test.0',
      logger: nullLogger,
      exporters: 'agent,file',
      profilers: 'space,wall',
      url: 'http://localhost:1234/',
      codeHotspotsEnabled: true
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
    expect(config.flushInterval).to.equal(65 * 1000)
    expect(config.exporters).to.be.an('array')
    expect(config.exporters.length).to.equal(2)
    expect(config.exporters[0]).to.be.an.instanceof(AgentExporter)
    expect(config.exporters[0]._url.toString()).to.equal(options.url)
    expect(config.exporters[1]).to.be.an.instanceof(FileExporter)
    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(2)
    expect(config.profilers[0]).to.be.an.instanceOf(SpaceProfiler)
    expect(config.profilers[1]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[1].codeHotspotsEnabled()).true
  })

  it('should filter out invalid profilers', () => {
    const errors = []
    const options = {
      logger: {
        debug () {},
        info () {},
        warn () {},
        error (error) {
          errors.push(error)
        }
      },
      profilers: 'nope,also_nope'
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(0)

    expect(errors.length).to.equal(2)
    expect(errors[0]).to.equal('Unknown profiler "nope"')
    expect(errors[1]).to.equal('Unknown profiler "also_nope"')
  })

  it('should support profiler config with empty DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: ''
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(0)
  })

  it('should support profiler config with DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '1',
      DD_PROFILING_V8_PROFILER_BUG_WORKAROUND: '0'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).true
    expect(config.v8ProfilerBugWorkaroundEnabled).false
  })

  it('should support profiler config with DD_PROFILING_XXX_ENABLED', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_WALLTIME_ENABLED: '0',
      DD_PROFILING_HEAP_ENABLED: '1'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(SpaceProfiler)
  })

  it('should deduplicate profilers', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall,wall',
      DD_PROFILING_WALLTIME_ENABLED: '1'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
  })

  it('should prioritize options over env variables', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'space',
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '1',
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: '1'
    }
    const options = {
      logger: nullLogger,
      profilers: ['wall'],
      codeHotspotsEnabled: false,
      endpointCollection: false
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).false
    expect(config.profilers[0].endpointCollectionEnabled()).false
  })

  it('should prioritize non-experimental env variables and warn about experimental ones', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '0',
      DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED: '1',
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: '0',
      DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED: '1'
    }
    const warnings = []
    const options = {
      logger: {
        debug () {},
        info () {},
        warn (warning) {
          warnings.push(warning)
        },
        error () {}
      }
    }

    const config = new Config(options)

    expect(warnings.length).to.equal(2)
    expect(warnings[0]).to.equal(
      'DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED is deprecated. ' +
      'Use DD_PROFILING_ENDPOINT_COLLECTION_ENABLED instead.')
    expect(warnings[1]).to.equal(
      'DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED is deprecated. ' +
      'Use DD_PROFILING_CODEHOTSPOTS_ENABLED instead.')

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).false
    expect(config.profilers[0].endpointCollectionEnabled()).false
  })

  it('should implicitly turn on code hotspots for endpoint profiling when they are not explicitly disabled', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: '1'
    }
    const infos = []
    const options = {
      logger: {
        debug () {},
        info (info) {
          infos.push(info)
        },
        warn () {},
        error () {}
      }
    }

    const config = new Config(options)

    expect(infos.length).to.equal(1)
    expect(infos[0]).to.equal('Code Hotspots are implicitly enabled by endpoint collection.')

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).true
    expect(config.profilers[0].endpointCollectionEnabled()).true
  })

  it('should warn about code hotspots being explicitly disabled with endpoint profiling', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '0',
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: '1'
    }
    const warnings = []
    const options = {
      logger: {
        debug () {},
        info () {},
        warn (warning) {
          warnings.push(warning)
        },
        error () {}
      }
    }

    const config = new Config(options)

    expect(warnings.length).to.equal(1)
    expect(warnings[0]).to.equal(
      'Endpoint collection is enabled, but Code Hotspots are disabled. ' +
      'Enable Code Hotspots too for endpoint collection to work.')

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).false
    expect(config.profilers[0].endpointCollectionEnabled()).false
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

  it('should support IPv6 hostname', () => {
    const options = {
      hostname: '::1'
    }

    const config = new Config(options)
    const exporterUrl = config.exporters[0]._url.toString()
    const expectedUrl = new URL('http://[::1]:8126').toString()

    expect(exporterUrl).to.equal(expectedUrl)
  })

  it('should support OOM heap profiler configuration', () => {
    process.env = {
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 'false'
    }
    const config = new Config({})

    expect(config.oomMonitoring).to.deep.equal({
      enabled: false,
      heapLimitExtensionSize: 0,
      maxHeapExtensionCount: 0,
      exportStrategies: [],
      exportCommand: undefined
    })
  })

  it('should enable OOM heap profiler by default and use process as default strategy', () => {
    const config = new Config()

    expect(config.oomMonitoring).to.deep.equal({
      enabled: true,
      heapLimitExtensionSize: 0,
      maxHeapExtensionCount: 0,
      exportStrategies: ['process'],
      exportCommand: [
        process.execPath,
        path.normalize(path.join(__dirname, '../../src/profiling', 'exporter_cli.js')),
        'http://localhost:8126/',
        `host:${config.host},service:node,snapshot:on_oom`,
        'space'
      ]
    })
  })

  it('should support OOM heap profiler configuration', () => {
    process.env = {
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: '1',
      DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: '1000000',
      DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: '2',
      DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'process,async,process'
    }

    const config = new Config({})

    expect(config.oomMonitoring).to.deep.equal({
      enabled: true,
      heapLimitExtensionSize: 1000000,
      maxHeapExtensionCount: 2,
      exportStrategies: ['process', 'async'],
      exportCommand: [
        process.execPath,
        path.normalize(path.join(__dirname, '../../src/profiling', 'exporter_cli.js')),
        'http://localhost:8126/',
        `host:${config.host},service:node,snapshot:on_oom`,
        'space'
      ]
    })
  })
})
