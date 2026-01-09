'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const satisfies = require('semifies')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const { AgentExporter } = require('../../src/profiling/exporters/agent')
const { FileExporter } = require('../../src/profiling/exporters/file')
const WallProfiler = require('../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../src/profiling/profilers/space')
const EventsProfiler = require('../../src/profiling/profilers/events')
const { ConsoleLogger } = require('../../src/profiling/loggers/console')

const samplingContextsAvailable = process.platform !== 'win32'
const oomMonitoringSupported = process.platform !== 'win32'
const isAtLeast24 = satisfies(process.versions.node, '>=24.0.0')
const zstdOrGzip = isAtLeast24 ? 'zstd' : 'gzip'

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

    assertObjectContains(config, {
      service: 'node',
      flushInterval: 65 * 1000
    })

    assert.deepStrictEqual(config.tags, {
      service: 'node',
      host: os.hostname()
    })

    assert.ok(config.logger instanceof ConsoleLogger)
    assert.ok(config.exporters[0] instanceof AgentExporter)
    assert.ok(config.profilers[0] instanceof SpaceProfiler)
    assert.ok(config.profilers[1] instanceof WallProfiler)
    assert.strictEqual(config.profilers[1].codeHotspotsEnabled(), samplingContextsAvailable)
    assert.strictEqual(config.v8ProfilerBugWorkaroundEnabled, true)
    assert.strictEqual(config.cpuProfilingEnabled, samplingContextsAvailable)
    assert.strictEqual(config.uploadCompression.method, zstdOrGzip)
    assert.strictEqual(config.uploadCompression.level, undefined)
  })

  it('should support configuration options', () => {
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

    assert.strictEqual(config.service, options.service)
    assert.strictEqual(typeof config.host, 'string')
    assert.strictEqual(config.version, options.version)
    assert.ok(typeof config.tags === 'object' && config.tags !== null)
    assert.strictEqual(typeof config.tags.host, 'string')
    assert.strictEqual(config.tags.service, options.service)
    assert.strictEqual(config.tags.version, options.version)
    assert.strictEqual(config.flushInterval, 65 * 1000)
    assert.ok(Array.isArray(config.exporters))
    assert.strictEqual(config.exporters.length, 2)
    assert.ok(config.exporters[0] instanceof AgentExporter)
    assert.strictEqual(config.exporters[0]._url.toString(), options.url)
    assert.ok(config.exporters[1] instanceof FileExporter)
    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 2 + (samplingContextsAvailable ? 1 : 0))
    assert.ok(config.profilers[0] instanceof SpaceProfiler)
    assert.ok(config.profilers[1] instanceof WallProfiler)
    assert.strictEqual(config.profilers[1].codeHotspotsEnabled(), false)
    if (samplingContextsAvailable) {
      assert.ok(config.profilers[2] instanceof EventsProfiler)
    }
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

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 0)

    assert.strictEqual(errors.length, 2)
    assert.strictEqual(errors[0], 'Unknown profiler "nope"')
    assert.strictEqual(errors[1], 'Unknown profiler "also_nope"')
  })

  it('should support profiler config with empty DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: ''
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 0)
  })

  it('should support profiler config with DD_PROFILING_PROFILERS', () => {
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

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 1 + (samplingContextsAvailable ? 1 : 0))
    assert.ok(config.profilers[0] instanceof WallProfiler)
    assert.strictEqual(config.profilers[0].codeHotspotsEnabled(), samplingContextsAvailable)
    if (samplingContextsAvailable) {
      assert.ok(config.profilers[1] instanceof EventsProfiler)
    }
    assert.strictEqual(config.v8ProfilerBugWorkaroundEnabled, false)
    assert.strictEqual(config.cpuProfilingEnabled, samplingContextsAvailable)
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

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 1)
    assert.ok(config.profilers[0] instanceof SpaceProfiler)
  })

  it('should ensure space profiler is ordered first with DD_PROFILING_HEAP_ENABLED', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_HEAP_ENABLED: '1'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 2 + (samplingContextsAvailable ? 1 : 0))
    assert.ok(config.profilers[0] instanceof SpaceProfiler)
    assert.ok(config.profilers[1] instanceof WallProfiler)
  })

  it('should ensure space profiler order is preserved when explicitly set with DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall,space',
      DD_PROFILING_HEAP_ENABLED: '1'
    }
    const options = {
      logger: nullLogger
    }

    const config = new Config(options)

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 2 + (samplingContextsAvailable ? 1 : 0))
    assert.ok(config.profilers[0] instanceof WallProfiler)
    assert.ok(config.profilers[1] instanceof SpaceProfiler)
  })

  it('should be able to read some env vars', () => {
    const oldenv = process.env
    process.env = {
      DD_PROFILING_DEBUG_SOURCE_MAPS: '1',
      DD_PROFILING_HEAP_SAMPLING_INTERVAL: '1000',
      DD_PROFILING_PPROF_PREFIX: 'test-prefix',
      DD_PROFILING_UPLOAD_TIMEOUT: '10000',
      DD_PROFILING_TIMELINE_ENABLED: '0'
    }

    const options = {
      logger: nullLogger
    }

    const config = new Config(options)
    assert.strictEqual(config.debugSourceMaps, true)
    assert.strictEqual(config.heapSamplingInterval, 1000)
    assert.strictEqual(config.pprofPrefix, 'test-prefix')
    assert.strictEqual(config.uploadTimeout, 10000)
    assert.strictEqual(config.timelineEnabled, false)

    process.env = oldenv
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

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 1 + (samplingContextsAvailable ? 1 : 0))
    assert.ok(config.profilers[0] instanceof WallProfiler)
    if (samplingContextsAvailable) {
      assert.ok(config.profilers[1] instanceof EventsProfiler)
    }
  })

  it('should prioritize options over env variables', () => {
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

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 2)
    assert.ok(config.profilers[0] instanceof WallProfiler)
    assert.strictEqual(config.profilers[0].codeHotspotsEnabled(), false)
    assert.strictEqual(config.profilers[0].endpointCollectionEnabled(), false)
    assert.ok(config.profilers[1] instanceof EventsProfiler)
  })

  it('should prioritize non-experimental env variables and warn about experimental ones', () => {
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

    assert.ok(Array.isArray(config.profilers))
    assert.strictEqual(config.profilers.length, 2)
    assert.ok(config.profilers[0] instanceof WallProfiler)
    assert.strictEqual(config.profilers[0].codeHotspotsEnabled(), false)
    assert.strictEqual(config.profilers[0].endpointCollectionEnabled(), false)
    assert.ok(config.profilers[1] instanceof EventsProfiler)
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
      assert.throws(() => { new Config(options) }, `${name} not supported on `)
    }
  }

  function optionOnlyWorksWithSamplingContexts (property, name) {
    optionOnlyWorksWithGivenCondition(property, name, samplingContextsAvailable)
  }

  it('should only allow code hotspots on supported platforms', () => {
    optionOnlyWorksWithSamplingContexts('codeHotspotsEnabled', 'Code hotspots')
  })

  it('should only allow endpoint collection on supported platforms', () => {
    optionOnlyWorksWithSamplingContexts('endpointCollection', 'Endpoint collection')
  })

  it('should only allow CPU profiling on supported platforms', () => {
    optionOnlyWorksWithSamplingContexts('cpuProfilingEnabled', 'CPU profiling')
  })

  it('should only allow timeline view on supported platforms', () => {
    optionOnlyWorksWithSamplingContexts('timelineEnabled', 'Timeline view')
  })

  it('should only allow OOM monitoring on supported platforms', () => {
    optionOnlyWorksWithGivenCondition('oomMonitoring', 'OOM monitoring', oomMonitoringSupported)
  })

  it('should support tags', () => {
    const tags = {
      env: 'dev'
    }

    const config = new Config({ tags })

    assertObjectContains(config.tags, tags)
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

    assertObjectContains(config.tags, { env, service, version })
  })

  it('should add source code integration tags if git metadata is available', () => {
    const DUMMY_GIT_SHA = '13851f2b092e97acebab1b73f6c0e7818e795b50'
    const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/sci_git_example.git'

    const config = new Config({
      repositoryUrl: DUMMY_REPOSITORY_URL,
      commitSHA: DUMMY_GIT_SHA
    })

    assertObjectContains(config.tags, { 'git.repository_url': DUMMY_REPOSITORY_URL, 'git.commit.sha': DUMMY_GIT_SHA })
  })

  it('should support IPv6 hostname', () => {
    const options = {
      hostname: '::1'
    }

    const config = new Config(options)
    const exporterUrl = config.exporters[0]._url.toString()
    const expectedUrl = new URL('http://[::1]:8126').toString()

    assert.strictEqual(exporterUrl, expectedUrl)
  })

  it('should support OOM heap profiler configuration', () => {
    process.env = {
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 'false'
    }
    const config = new Config({})

    assert.deepStrictEqual(config.oomMonitoring, {
      enabled: false,
      heapLimitExtensionSize: 0,
      maxHeapExtensionCount: 0,
      exportStrategies: [],
      exportCommand: undefined
    })
  })

  it('should enable OOM heap profiler by default and use process as default strategy', () => {
    const config = new Config()

    if (oomMonitoringSupported) {
      assert.deepStrictEqual(config.oomMonitoring, {
        enabled: oomMonitoringSupported,
        heapLimitExtensionSize: 0,
        maxHeapExtensionCount: 0,
        exportStrategies: ['process'],
        exportCommand: [
          process.execPath,
          path.normalize(path.join(__dirname, '../../src/profiling', 'exporter_cli.js')),
          'http://127.0.0.1:8126/',
          `host:${config.host},service:node,snapshot:on_oom`,
          'space'
        ]
      })
    } else {
      assert.strictEqual(config.oomMonitoring.enabled, false)
    }
  })

  it('should allow configuring exporters by string or string array', async () => {
    const checks = [
      'agent',
      ['agent']
    ]

    for (const exporters of checks) {
      const config = new Config({
        sourceMap: false,
        exporters
      })

      assert.strictEqual(typeof config.exporters[0].export, 'function')
    }
  })

  it('should allow configuring profilers by string or string arrays', async () => {
    const checks = [
      ['space', SpaceProfiler],
      ['wall', WallProfiler, EventsProfiler],
      ['space,wall', SpaceProfiler, WallProfiler, EventsProfiler],
      ['wall,space', WallProfiler, SpaceProfiler, EventsProfiler],
      [['space', 'wall'], SpaceProfiler, WallProfiler, EventsProfiler],
      [['wall', 'space'], WallProfiler, SpaceProfiler, EventsProfiler]
    ].map(profilers => profilers.filter(profiler => samplingContextsAvailable || profiler !== EventsProfiler))

    for (const [profilers, ...expected] of checks) {
      const config = new Config({
        sourceMap: false,
        profilers
      })

      assert.strictEqual(config.profilers.length, expected.length)
      for (let i = 0; i < expected.length; i++) {
        assert.ok(config.profilers[i] instanceof expected[i])
      }
    }
  })

  if (oomMonitoringSupported) {
    it('should support OOM heap profiler configuration', function () {
      process.env = {
        DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: '1',
        DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: '1000000',
        DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: '2',
        DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'process,async,process'
      }

      const config = new Config({})

      assert.deepStrictEqual(config.oomMonitoring, {
        enabled: true,
        heapLimitExtensionSize: 1000000,
        maxHeapExtensionCount: 2,
        exportStrategies: ['process', 'async'],
        exportCommand: [
          process.execPath,
          path.normalize(path.join(__dirname, '../../src/profiling', 'exporter_cli.js')),
          'http://127.0.0.1:8126/',
          `host:${config.host},service:node,snapshot:on_oom`,
          'space'
        ]
      })
    })
  }

  describe('async context', () => {
    const isSupported = samplingContextsAvailable && isAtLeast24
    describe('where supported', () => {
      it('should be on by default', function () {
        if (!isSupported) {
          this.skip()
        } else {
          const config = new Config({})
          assert.strictEqual(config.asyncContextFrameEnabled, true)
        }
      })

      it('can be turned off by env var', function () {
        if (!isSupported) {
          this.skip()
        } else {
          process.env.DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED = '0'
          try {
            const config = new Config({})
            assert.strictEqual(config.asyncContextFrameEnabled, false)
          } finally {
            delete process.env.DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED
          }
        }
      })
    })

    describe('where not supported', function () {
      it('should be off by default', function () {
        if (isSupported) {
          this.skip()
        } else {
          const config = new Config({})
          assert.strictEqual(config.asyncContextFrameEnabled, false)
        }
      })

      it('can not be turned on by env var', function () {
        if (isSupported) {
          this.skip()
        } else {
          process.env.DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED = '1'
          try {
            const config = new Config({})
            assert.strictEqual(config.asyncContextFrameEnabled, false)
          } finally {
            delete process.env.DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED
          }
        }
      })
    })
  })

  describe('upload compression settings', () => {
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
        assert.strictEqual(logger.warnings.length, 1)
        assert.strictEqual(logger.warnings[0], warning)
      } else {
        assert.strictEqual(logger.warnings.length, 0)
      }

      assert.deepStrictEqual(config.uploadCompression, { method, level })
    }

    it('should accept known methods', () => {
      expectConfig(undefined, zstdOrGzip, undefined)
      expectConfig('off', 'off', undefined)
      expectConfig('on', zstdOrGzip, undefined)
      expectConfig('gzip', 'gzip', undefined)
      expectConfig('zstd', 'zstd', undefined)
    })

    it('should reject unknown methods', () => {
      expectConfig('foo', zstdOrGzip, undefined, 'Invalid profile upload compression method "foo". Will use "on".')
    })

    it('should accept supported compression levels in methods that support levels', () => {
      [['gzip', 9], ['zstd', 22]].forEach(([method, maxLevel]) => {
        for (let i = 1; i <= maxLevel; i++) {
          expectConfig(`${method}-${i}`, method, i)
        }
      })
    })

    it('should reject invalid compression levels in methods that support levels', () => {
      ['gzip', 'zstd'].forEach((method) => {
        expectConfig(`${method}-foo`, method, undefined,
          'Invalid compression level "foo". Will use default level.')
      })
    })

    it('should reject compression levels in methods that do not support levels', () => {
      ['on', 'off'].forEach((method) => {
        const effectiveMethod = method === 'on' ? zstdOrGzip : method
        expectConfig(`${method}-3`, effectiveMethod, undefined,
          `Compression levels are not supported for "${method}".`)
        expectConfig(`${method}-foo`, effectiveMethod, undefined,
          `Compression levels are not supported for "${method}".`)
      })
    })

    it('should normalize compression levels', () => {
      expectConfig('gzip-0', 'gzip', 1, 'Invalid compression level 0. Will use 1.')
      expectConfig('gzip-10', 'gzip', 9, 'Invalid compression level 10. Will use 9.')
      expectConfig('gzip-3.14', 'gzip', 3)
      expectConfig('zstd-0', 'zstd', 1, 'Invalid compression level 0. Will use 1.')
      expectConfig('zstd-23', 'zstd', 22, 'Invalid compression level 23. Will use 22.')
      expectConfig('zstd-3.14', 'zstd', 3)
    })
  })
})
