'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const satisfies = require('semifies')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const { getConfigFresh } = require('../helpers/config')
const { AgentExporter } = require('../../src/profiling/exporters/agent')
const { FileExporter } = require('../../src/profiling/exporters/file')
const WallProfiler = require('../../src/profiling/profilers/wall')
const SpaceProfiler = require('../../src/profiling/profilers/space')
const EventsProfiler = require('../../src/profiling/profilers/events')
const { ConsoleLogger } = require('../../src/profiling/loggers/console')
const { isACFActive } = require('../../../datadog-core/src/storage')

const samplingContextsAvailable = process.platform !== 'win32'
const oomMonitoringSupported = process.platform !== 'win32'
const isAtLeast24 = satisfies(process.versions.node, '>=24.0.0')
const zstdOrGzip = isAtLeast24 ? 'zstd' : 'gzip'

/** @typedef {InstanceType<(typeof import('../../src/profiling/config'))['Config']>} ProfilerConfig */

describe('config', () => {
  let env

  beforeEach(() => {
    env = process.env
    process.env = {}
  })

  afterEach(() => {
    process.env = env
  })

  /**
   * @param {Record<string, unknown>} [tracerOptions]
   * @returns {{config: ProfilerConfig, warnings: string[], errors: string[]}}
   */
  function getProfilerConfig (tracerOptions) {
    process.env.DD_PROFILING_ENABLED = '1'

    const tracerConfig = getConfigFresh(tracerOptions)

    const ProfilingConfig = require('../../src/profiling/config').Config
    const config = /** @type {ProfilerConfig} */ (new ProfilingConfig(tracerConfig))

    return {
      config,
      warnings: [],
      errors: [],
    }
  }

  it('should have the correct defaults', () => {
    const { config } = getProfilerConfig()

    assertObjectContains(config, {
      flushInterval: 65 * 1000,
      activation: 'manual',
      v8ProfilerBugWorkaroundEnabled: true,
      cpuProfilingEnabled: samplingContextsAvailable,
      uploadCompression: {
        method: zstdOrGzip,
        level: undefined,
      },
    })
    assert.strictEqual(typeof config.service, 'string')
    assert.ok(config.service.length > 0)
    assert.strictEqual(typeof config.version, 'string')
    assertObjectContains(config.tags, {
      service: config.service,
      version: config.version,
    })
    assert.strictEqual(config.tags.host, undefined)
    assert.ok(config.logger instanceof ConsoleLogger)
    assert.deepStrictEqual(
      config.profilers.slice(0, 2).map(profiler => profiler.constructor),
      [SpaceProfiler, WallProfiler]
    )
    assert.strictEqual(
      /** @type {InstanceType<typeof WallProfiler>} */ (config.profilers[1]).codeHotspotsEnabled(),
      samplingContextsAvailable
    )
    assert.deepStrictEqual(config.exporters.map(exporter => exporter.constructor), [AgentExporter])
  })

  it('should support configuration options', () => {
    process.env = {
      DD_PROFILING_EXPORTERS: 'agent,file',
      DD_PROFILING_PROFILERS: 'space,wall',
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '0',
    }

    const { config } = getProfilerConfig({
      service: 'test',
      version: '1.2.3-test.0',
      url: 'http://localhost:1234/',
      reportHostname: true,
    })

    assertObjectContains(config, {
      service: 'test',
      version: '1.2.3-test.0',
      flushInterval: 65 * 1000,
      tags: {
        service: 'test',
        version: '1.2.3-test.0',
      },
    })
    assert.strictEqual(typeof config.tags.host, 'string')
    assert.strictEqual(config.exporters[0]._url.toString(), 'http://localhost:1234/')
    assert.deepStrictEqual(
      config.exporters.map(exporter => exporter.constructor),
      [AgentExporter, FileExporter]
    )
    assert.deepStrictEqual(
      config.profilers.map(profiler => profiler.constructor),
      samplingContextsAvailable
        ? [SpaceProfiler, WallProfiler, EventsProfiler]
        : [SpaceProfiler, WallProfiler]
    )
    assert.strictEqual(
      /** @type {InstanceType<typeof WallProfiler>} */ (config.profilers[1]).codeHotspotsEnabled(),
      false
    )
  })

  it('should not include host tag when reportHostname is false', () => {
    const { config } = getProfilerConfig({ reportHostname: false })

    assert.strictEqual(config.tags.host, undefined)
    assert.ok(!('host' in config.tags))
  })

  it('should not include host tag when reportHostname is not set', () => {
    const { config } = getProfilerConfig()

    assert.strictEqual(config.tags.host, undefined)
    assert.ok(!('host' in config.tags))
  })

  it('should include host tag when reportHostname is true', () => {
    const { config } = getProfilerConfig({ reportHostname: true })

    assert.strictEqual(typeof config.tags.host, 'string')
    assert.ok(config.tags.host.length > 0)
    assert.strictEqual(config.tags.host, os.hostname())
  })

  it('should filter out invalid profilers', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'nope,also_nope',
    }

    /** @type {string[]} */
    const errors = []
    const logger = {
      debug () {},
      info () {},
      warn () {},
      error (message) {
        errors.push(String(message))
      },
    }

    const { config } = getProfilerConfig({ logger })

    assert.deepStrictEqual(config.profilers.map(profiler => profiler.constructor), [])
    assert.deepStrictEqual(errors, [
      'Unknown profiler "nope"',
      'Unknown profiler "also_nope"',
    ])
  })

  it('should support profiler config with empty DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: '',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(config.profilers.map(profiler => profiler.constructor), [])
  })

  it('should support profiler config with DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_V8_PROFILER_BUG_WORKAROUND: '0',
    }

    const { config } = getProfilerConfig()

    assertObjectContains(config, {
      v8ProfilerBugWorkaroundEnabled: false,
      cpuProfilingEnabled: samplingContextsAvailable,
    })
    assert.deepStrictEqual(
      config.profilers.map(profiler => profiler.constructor),
      samplingContextsAvailable
        ? [WallProfiler, EventsProfiler]
        : [WallProfiler]
    )
    assert.strictEqual(
      /** @type {InstanceType<typeof WallProfiler>} */ (config.profilers[0]).codeHotspotsEnabled(),
      samplingContextsAvailable
    )
  })

  it('should support profiler config with DD_PROFILING_XXX_ENABLED', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_WALLTIME_ENABLED: '0',
      DD_PROFILING_HEAP_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(config.profilers.map(profiler => profiler.constructor), [SpaceProfiler])
  })

  it('should ensure space profiler is ordered first with DD_PROFILING_HEAP_ENABLED', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_HEAP_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(
      config.profilers.map(profiler => profiler.constructor),
      samplingContextsAvailable
        ? [SpaceProfiler, WallProfiler, EventsProfiler]
        : [SpaceProfiler, WallProfiler]
    )
  })

  it('should ensure space profiler order is preserved when explicitly set with DD_PROFILING_PROFILERS', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall,space',
      DD_PROFILING_HEAP_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(
      config.profilers.map(profiler => profiler.constructor),
      samplingContextsAvailable
        ? [WallProfiler, SpaceProfiler, EventsProfiler]
        : [WallProfiler, SpaceProfiler]
    )
  })

  it('should be able to read some env vars', () => {
    process.env = {
      DD_PROFILING_DEBUG_SOURCE_MAPS: '1',
      DD_PROFILING_HEAP_SAMPLING_INTERVAL: '1000',
      DD_PROFILING_PPROF_PREFIX: 'test-prefix',
      DD_PROFILING_UPLOAD_TIMEOUT: '10000',
      DD_PROFILING_TIMELINE_ENABLED: '0',
    }

    const { config } = getProfilerConfig()

    assertObjectContains(config, {
      debugSourceMaps: true,
      heapSamplingInterval: 1000,
      pprofPrefix: 'test-prefix',
      uploadTimeout: 10000,
      timelineEnabled: false,
    })
  })

  it('should deduplicate profilers', () => {
    process.env = {
      DD_PROFILING_PROFILERS: 'wall,wall',
      DD_PROFILING_WALLTIME_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(
      config.profilers.map(profiler => profiler.constructor),
      samplingContextsAvailable
        ? [WallProfiler, EventsProfiler]
        : [WallProfiler]
    )
  })

  it('should prioritize non-experimental env variables and warn about experimental ones', function () {
    if (!samplingContextsAvailable) {
      this.skip()
      return
    }

    process.env = {
      DD_PROFILING_PROFILERS: 'wall',
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '0',
      DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED: '1',
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: '0',
      DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(
      config.profilers.map(profiler => profiler.constructor),
      [WallProfiler, EventsProfiler]
    )
    assert.strictEqual(
      /** @type {InstanceType<typeof WallProfiler>} */ (config.profilers[0]).codeHotspotsEnabled(),
      false
    )
    assert.strictEqual(
      /** @type {InstanceType<typeof WallProfiler>} */ (config.profilers[0]).endpointCollectionEnabled(),
      false
    )
  })

  it('should disable code hotspots on unsupported platforms', function () {
    process.env = {
      DD_PROFILING_CODEHOTSPOTS_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.strictEqual(config.codeHotspotsEnabled, samplingContextsAvailable)
  })

  it('should disable endpoint collection on unsupported platforms', function () {
    process.env = {
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.strictEqual(config.endpointCollectionEnabled, samplingContextsAvailable)
  })

  it('should disable CPU profiling on unsupported platforms', function () {
    process.env = {
      DD_PROFILING_CPU_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.strictEqual(config.cpuProfilingEnabled, samplingContextsAvailable)
  })

  it('should disable timeline view on unsupported platforms', function () {
    process.env = {
      DD_PROFILING_TIMELINE_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.strictEqual(config.timelineEnabled, samplingContextsAvailable)
  })

  it('should disable OOM monitoring on unsupported platforms', function () {
    process.env = {
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: '1',
    }

    const { config } = getProfilerConfig()

    assert.strictEqual(config.oomMonitoring.enabled, oomMonitoringSupported)
  })

  it('should support tags', () => {
    const tags = {
      env: 'dev',
    }

    const { config } = getProfilerConfig({ tags })

    assertObjectContains(config.tags, tags)
  })

  it('should prioritize options over tags', () => {
    const env = 'prod'
    const service = 'foo'
    const version = '1.2.3'
    const tags = {
      env: 'dev',
      service: 'bar',
      version: '3.2.1',
    }

    const { config } = getProfilerConfig({ env, service, version, tags })

    assertObjectContains(config.tags, { env, service, version })
  })

  it('should add source code integration tags if git metadata is available', () => {
    const DUMMY_GIT_SHA = '13851f2b092e97acebab1b73f6c0e7818e795b50'
    const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/sci_git_example.git'

    process.env = {
      DD_GIT_COMMIT_SHA: DUMMY_GIT_SHA,
      DD_GIT_REPOSITORY_URL: DUMMY_REPOSITORY_URL,
    }

    const { config } = getProfilerConfig()

    assertObjectContains(config.tags, { 'git.repository_url': DUMMY_REPOSITORY_URL, 'git.commit.sha': DUMMY_GIT_SHA })
  })

  it('should support IPv6 hostname', () => {
    const { config } = getProfilerConfig({
      hostname: '::1',
      port: '8126',
    })

    const exporterUrl = config.exporters[0]._url.toString()
    const expectedUrl = new URL('http://[::1]:8126').toString()

    assert.strictEqual(exporterUrl, expectedUrl)
  })

  it('should support OOM heap profiler configuration', () => {
    process.env = {
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: 'false',
    }

    const { config } = getProfilerConfig()

    assert.deepStrictEqual(config.oomMonitoring, {
      enabled: false,
      heapLimitExtensionSize: 0,
      maxHeapExtensionCount: 0,
      exportStrategies: [],
      exportCommand: undefined,
    })
  })

  function assertOomExportCommand (config) {
    assert.ok(config.oomMonitoring.exportCommand[3].includes(`service:${config.service}`))
    assert.ok(config.oomMonitoring.exportCommand[3].includes('snapshot:on_oom'))
  }

  it('should enable OOM heap profiler by default and use process as default strategy', () => {
    const { config } = getProfilerConfig({ reportHostname: true })

    if (oomMonitoringSupported) {
      assertObjectContains(config.oomMonitoring, {
        enabled: true,
        heapLimitExtensionSize: 0,
        maxHeapExtensionCount: 0,
        exportStrategies: ['process'],
        exportCommand: [
          process.execPath,
          path.normalize(path.join(__dirname, '../../src/profiling', 'exporter_cli.js')),
          'http://127.0.0.1:8126/',
          'space',
        ],
      })
      assertOomExportCommand(config)
    } else {
      assert.strictEqual(config.oomMonitoring.enabled, false)
    }
  })

  it('should allow configuring exporters through DD_PROFILING_EXPORTERS', () => {
    /** @type {Array<[string, (typeof AgentExporter | typeof FileExporter)[]]>} */
    const checks = [
      ['agent', [AgentExporter]],
      ['agent,file', [AgentExporter, FileExporter]],
    ]

    for (const [exporters, expected] of checks) {
      process.env = {
        DD_PROFILING_EXPORTERS: exporters,
      }

      const { config } = getProfilerConfig()

      assert.deepStrictEqual(config.exporters.map(exporter => exporter.constructor), expected)
    }
  })

  it('should allow configuring profilers through DD_PROFILING_PROFILERS', () => {
    /** @type {Array<Array<string | typeof SpaceProfiler | typeof WallProfiler | typeof EventsProfiler>>} */
    const checks = [
      ['space', SpaceProfiler],
      ['wall', WallProfiler, EventsProfiler],
      ['space,wall', SpaceProfiler, WallProfiler, EventsProfiler],
      ['wall,space', WallProfiler, SpaceProfiler, EventsProfiler],
    ].map(profilers => profilers.filter(profiler => samplingContextsAvailable || profiler !== EventsProfiler))

    for (const check of checks) {
      const profilers = /** @type {string} */ (check[0])
      const expected = /** @type {Array<typeof SpaceProfiler | typeof WallProfiler | typeof EventsProfiler>} */ (
        check.slice(1)
      )
      process.env = {
        DD_PROFILING_PROFILERS: profilers,
      }

      const { config } = getProfilerConfig()

      assert.deepStrictEqual(config.profilers.map(profiler => profiler.constructor), expected)
    }
  })

  if (oomMonitoringSupported) {
    it('should support OOM heap profiler configuration', function () {
      process.env = {
        DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: '1',
        DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: '1000000',
        DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: '2',
        DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: 'process,async,process',
      }

      const { config } = getProfilerConfig({ reportHostname: true, tags: {} })

      assertObjectContains(config.oomMonitoring, {
        enabled: true,
        heapLimitExtensionSize: 1000000,
        maxHeapExtensionCount: 2,
        exportStrategies: ['process', 'async'],
        exportCommand: [
          process.execPath,
          path.normalize(path.join(__dirname, '../../src/profiling', 'exporter_cli.js')),
          'http://127.0.0.1:8126/',
          'space',
        ],
      })
      assertOomExportCommand(config)
    })
  }

  describe('async context', () => {
    const isSupported = samplingContextsAvailable && isACFActive
    describe('where supported', () => {
      it('should be on by default', function () {
        if (!isSupported) {
          this.skip()
        } else {
          const { config } = getProfilerConfig()
          assert.strictEqual(config.asyncContextFrameEnabled, true)
        }
      })

      it('can be turned off by env var', function () {
        if (!isSupported) {
          this.skip()
        } else {
          process.env = {
            DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED: '0',
          }

          const { config } = getProfilerConfig()
          assert.strictEqual(config.asyncContextFrameEnabled, false)
        }
      })
    })

    describe('where not supported', function () {
      it('should be off by default', function () {
        if (isSupported) {
          this.skip()
        } else {
          const { config } = getProfilerConfig()
          assert.strictEqual(config.asyncContextFrameEnabled, false)
        }
      })

      it('can not be turned on by env var', function () {
        if (isSupported) {
          this.skip()
        } else {
          process.env = {
            DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED: '1',
          }

          const { config } = getProfilerConfig()
          assert.strictEqual(config.asyncContextFrameEnabled, false)
        }
      })
    })
  })

  describe('upload compression settings', () => {
    const expectConfig = (env, method, level, warning) => {
      process.env = env === undefined
        ? {}
        : { DD_PROFILING_DEBUG_UPLOAD_COMPRESSION: env }

      process.env.DD_TRACE_DEBUG = '1'

      /** @type {string[]} */
      const warnings = []
      const logger = {
        debug () {},
        info () {},
        warn (message) {
          warnings.push(message)
        },
        error () {},
      }

      const { config } = getProfilerConfig({ logger })
      const compressionWarnings = warnings.filter(message => {
        return message.includes('DD_PROFILING_DEBUG_UPLOAD_COMPRESSION') ||
          message.includes('Invalid compression level ')
      })

      if (warning) {
        assert.match(compressionWarnings.join('\n'), new RegExp(RegExp.escape(warning)))
      } else {
        assert.deepStrictEqual(compressionWarnings, [])
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
      expectConfig('foo', zstdOrGzip, undefined, "Invalid value: 'foo' for ")
    })

    it('should accept supported compression levels in methods that support levels', () => {
      /** @type {Array<[string, number]>} */
      const methods = [['gzip', 9], ['zstd', 22]]
      methods.forEach(([method, maxLevel]) => {
        for (let i = 1; i <= maxLevel; i++) {
          expectConfig(`${method}-${i}`, method, i)
        }
      })
    })

    it('should reject invalid compression levels in methods that support levels', () => {
      ['gzip', 'zstd'].forEach((method) => {
        expectConfig(`${method}-foo`, zstdOrGzip, undefined,
          `Invalid value: '${method}-foo' for DD_PROFILING_DEBUG_UPLOAD_COMPRESSION (source: env_var), picked default`)
      })
    })

    it('should reject compression levels in methods that do not support levels', () => {
      ['on', 'off'].forEach((method) => {
        expectConfig(`${method}-3`, zstdOrGzip, undefined,
          `Invalid value: '${method}-3' for DD_PROFILING_DEBUG_UPLOAD_COMPRESSION (source: env_var), picked default`)
        expectConfig(`${method}-foo`, zstdOrGzip, undefined,
          `Invalid value: '${method}-foo' for DD_PROFILING_DEBUG_UPLOAD_COMPRESSION (source: env_var), picked default`)
      })
    })

    it('should normalize compression levels', () => {
      expectConfig('gzip-0', zstdOrGzip, undefined, "Invalid value: 'gzip-0'")
      expectConfig('gzip-10', 'gzip', 9, 'Invalid compression level 10. Will use 9.')
      expectConfig('gzip-3.14', zstdOrGzip, undefined, "Invalid value: 'gzip-3.14'")
      expectConfig('zstd-0', zstdOrGzip, undefined, "Invalid value: 'zstd-0'")
      expectConfig('zstd-23', 'zstd', 22, 'Invalid compression level 23. Will use 22.')
      expectConfig('zstd-3.14', zstdOrGzip, undefined, "Invalid value: 'zstd-3.14'")
    })
  })
})
