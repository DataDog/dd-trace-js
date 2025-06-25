'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const os = require('os')
const path = require('path')

const { AgentExporter } = require('../../src/profiling/exporters/agent')
const { FileExporter } = require('../../src/profiling/exporters/file')
const WallProfiler = require('../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../src/profiling/profilers/space')
const EventsProfiler = require('../../src/profiling/profilers/events')
const { ConsoleLogger } = require('../../src/profiling/loggers/console')

const samplingContextsAvailable = process.platform !== 'win32'
const oomMonitoringSupported = process.platform !== 'win32'

t.test('config', t => {
  let Config
  let env
  const nullLogger = {
    debug () { },
    info () { },
    warn () { },
    error () { }
  }

  t.beforeEach(() => {
    Config = require('../../src/profiling/config').Config
    env = process.env
    process.env = {}
  })

  t.afterEach(() => {
    process.env = env
  })

  t.test('should have the correct defaults', t => {
    const config = new Config()

    expect(config).to.deep.include({
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
    expect(config.profilers[0].codeHotspotsEnabled()).to.equal(samplingContextsAvailable)
    expect(config.profilers[1]).to.be.an.instanceof(SpaceProfiler)
    expect(config.v8ProfilerBugWorkaroundEnabled).true
    expect(config.cpuProfilingEnabled).to.equal(samplingContextsAvailable)
    expect(config.uploadCompression.method).to.equal('gzip')
    expect(config.uploadCompression.level).to.be.undefined
    t.end()
  })

  t.test('should support configuration options', t => {
    const options = {
      service: 'test',
      version: '1.2.3-test.0',
      logger: nullLogger,
      exporters: 'agent,file',
      profilers: 'space,wall',
      url: 'http://localhost:1234/',
      codeHotspotsEnabled: false
    }

    const config = new Config(options)

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
    expect(config.profilers.length).to.equal(2 + samplingContextsAvailable)
    expect(config.profilers[0]).to.be.an.instanceOf(SpaceProfiler)
    expect(config.profilers[1]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[1].codeHotspotsEnabled()).false
    if (samplingContextsAvailable) {
      expect(config.profilers[2]).to.be.an.instanceOf(EventsProfiler)
    }
    t.end()
  })

  t.test('should filter out invalid profilers', t => {
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
    t.end()
  })

  t.test('should support profiler config with empty DD_PROFILING_PROFILERS', t => {
    process.env = {
      DD_PROFILING_PROFILERS: ''
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(0)
    t.end()
  })

  t.test('should support profiler config with DD_PROFILING_PROFILERS', t => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_V8_PROFILER_BUG_WORKAROUND: '0'
    }
    if (samplingContextsAvailable) {
      process.env.DD_PROFILING_EXPERIMENTAL_CPU_ENABLED = '1'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1 + samplingContextsAvailable)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).to.equal(samplingContextsAvailable)
    if (samplingContextsAvailable) {
      expect(config.profilers[1]).to.be.an.instanceOf(EventsProfiler)
    }
    expect(config.v8ProfilerBugWorkaroundEnabled).false
    expect(config.cpuProfilingEnabled).to.equal(samplingContextsAvailable)
    t.end()
  })

  t.test('should support profiler config with DD_PROFILING_XXX_ENABLED', t => {
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
    t.end()
  })

  t.test('should deduplicate profilers', t => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall,wall',
      DD_PROFILING_WALLTIME_ENABLED: '1'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(1 + samplingContextsAvailable)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    if (samplingContextsAvailable) {
      expect(config.profilers[1]).to.be.an.instanceOf(EventsProfiler)
    }
    t.end()
  })

  t.test('should prioritize options over env variables', t => {
    if (!samplingContextsAvailable) {
      return
    }

    process.env = {
      DD_PROFILING_PROFILERS: 'space',
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
    expect(config.profilers.length).to.equal(2)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).false
    expect(config.profilers[0].endpointCollectionEnabled()).false
    expect(config.profilers[1]).to.be.an.instanceOf(EventsProfiler)
    t.end()
  })

  t.test('should prioritize non-experimental env variables and warn about experimental ones', t => {
    if (!samplingContextsAvailable) {
      return
    }

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

    expect(config.profilers).to.be.an('array')
    expect(config.profilers.length).to.equal(2)
    expect(config.profilers[0]).to.be.an.instanceOf(WallProfiler)
    expect(config.profilers[0].codeHotspotsEnabled()).false
    expect(config.profilers[0].endpointCollectionEnabled()).false
    expect(config.profilers[1]).to.be.an.instanceOf(EventsProfiler)
    t.end()
  })

  function optionOnlyWorksWithGivenCondition (property, name, condition) {
    const options = {
      [property]: true
    }

    if (condition) {
      // should silently succeed
      // eslint-disable-next-line no-new
      new Config(options)
    } else {
      // should throw
      // eslint-disable-next-line no-new
      expect(() => { new Config(options) }).to.throw(`${name} not supported on `)
    }
  }

  function optionOnlyWorksWithSamplingContexts (property, name) {
    optionOnlyWorksWithGivenCondition(property, name, samplingContextsAvailable)
  }

  t.test('should only allow code hotspots on supported platforms', t => {
    optionOnlyWorksWithSamplingContexts('codeHotspotsEnabled', 'Code hotspots')
    t.end()
  })

  t.test('should only allow endpoint collection on supported platforms', t => {
    optionOnlyWorksWithSamplingContexts('endpointCollection', 'Endpoint collection')
    t.end()
  })

  t.test('should only allow CPU profiling on supported platforms', t => {
    optionOnlyWorksWithSamplingContexts('cpuProfilingEnabled', 'CPU profiling')
    t.end()
  })

  t.test('should only allow timeline view on supported platforms', t => {
    optionOnlyWorksWithSamplingContexts('timelineEnabled', 'Timeline view')
    t.end()
  })

  t.test('should only allow OOM monitoring on supported platforms', t => {
    optionOnlyWorksWithGivenCondition('oomMonitoring', 'OOM monitoring', oomMonitoringSupported)
    t.end()
  })

  t.test('should support tags', t => {
    const tags = {
      env: 'dev'
    }

    const config = new Config({ tags })

    expect(config.tags).to.include(tags)
    t.end()
  })

  t.test('should prioritize options over tags', t => {
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
    t.end()
  })

  t.test('should add source code integration tags if git metadata is available', t => {
    const DUMMY_GIT_SHA = '13851f2b092e97acebab1b73f6c0e7818e795b50'
    const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/sci_git_example.git'

    const config = new Config({
      repositoryUrl: DUMMY_REPOSITORY_URL,
      commitSHA: DUMMY_GIT_SHA
    })

    expect(config.tags).to.include({ 'git.repository_url': DUMMY_REPOSITORY_URL, 'git.commit.sha': DUMMY_GIT_SHA })
    t.end()
  })

  t.test('should support IPv6 hostname', t => {
    const options = {
      hostname: '::1'
    }

    const config = new Config(options)
    const exporterUrl = config.exporters[0]._url.toString()
    const expectedUrl = new URL('http://[::1]:8126').toString()

    expect(exporterUrl).to.equal(expectedUrl)
    t.end()
  })

  t.test('should support OOM heap profiler configuration', t => {
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
    t.end()
  })

  t.test('should enable OOM heap profiler by default and use process as default strategy', t => {
    const config = new Config()

    if (oomMonitoringSupported) {
      expect(config.oomMonitoring).to.deep.equal({
        enabled: oomMonitoringSupported,
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
    } else {
      expect(config.oomMonitoring.enabled).to.be.false
    }
    t.end()
  })

  if (oomMonitoringSupported) {
    t.test('should support OOM heap profiler configuration', function (t) {
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
      t.end()
    })
  }

  t.test('upload compression settings', t => {
    const expectConfig = (env, method, level, warning) => {
      process.env = {
        DD_PROFILING_DEBUG_UPLOAD_COMPRESSION: env
      }

      const logger = {
        warnings: [],
        debug () {},
        info () {},
        warn (message) {
          this.warnings.push(message)
        },
        error () {}
      }
      const config = new Config({ logger })

      if (warning) {
        expect(logger.warnings.length).to.equals(1)
        expect(logger.warnings[0]).to.equal(warning)
      } else {
        expect(logger.warnings.length).to.equals(0)
      }

      expect(config.uploadCompression).to.deep.equal({ method, level })
    }

    t.test('should accept known methods', t => {
      expectConfig(undefined, 'gzip', undefined)
      expectConfig('off', 'off', undefined)
      expectConfig('on', 'gzip', undefined)
      expectConfig('gzip', 'gzip', undefined)
      expectConfig('zstd', 'zstd', undefined)
      t.end()
    })

    t.test('should reject unknown methods', t => {
      expectConfig('foo', 'gzip', undefined, 'Invalid profile upload compression method "foo". Will use "on".')
      t.end()
    })

    t.test('should accept supported compression levels in methods that support levels', t => {
      [['gzip', 9], ['zstd', 22]].forEach(([method, maxLevel]) => {
        for (let i = 1; i <= maxLevel; i++) {
          expectConfig(`${method}-${i}`, method, i)
        }
      })
      t.end()
    })

    t.test('should reject invalid compression levels in methods that support levels', t => {
      ['gzip', 'zstd'].forEach((method) => {
        expectConfig(`${method}-foo`, method, undefined,
          'Invalid compression level "foo". Will use default level.')
      })
      t.end()
    })

    t.test('should reject compression levels in methods that do not support levels', t => {
      ['on', 'off'].forEach((method) => {
        const effectiveMethod = method === 'on' ? 'gzip' : method
        expectConfig(`${method}-3`, effectiveMethod, undefined,
          `Compression levels are not supported for "${method}".`)
        expectConfig(`${method}-foo`, effectiveMethod, undefined,
          `Compression levels are not supported for "${method}".`)
      })
      t.end()
    })

    t.test('should normalize compression levels', t => {
      expectConfig('gzip-0', 'gzip', 1, 'Invalid compression level 0. Will use 1.')
      expectConfig('gzip-10', 'gzip', 9, 'Invalid compression level 10. Will use 9.')
      expectConfig('gzip-3.14', 'gzip', 3)
      expectConfig('zstd-0', 'zstd', 1, 'Invalid compression level 0. Will use 1.')
      expectConfig('zstd-23', 'zstd', 22, 'Invalid compression level 23. Will use 22.')
      expectConfig('zstd-3.14', 'zstd', 3)
      t.end()
    })
    t.end()
  })
  t.end()
})
