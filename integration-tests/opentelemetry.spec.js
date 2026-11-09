'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises')

const { execFile, fork } = require('node:child_process')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { promisify } = require('node:util')

const semver = require('semver')

const httpRequest = require('../packages/dd-trace/test/setup/helpers/http-client')
const latestVersions = require('../packages/dd-trace/test/plugins/versions/package.json').dependencies
const { FakeAgent, sandboxCwd, useSandbox, stopProc } = require('./helpers')

const OTEL_API_VERSIONS = ['1.4.1', '1.8.0', '1.9.0', '1.9.1', latestVersions['@opentelemetry/api']]
const execFileAsync = promisify(execFile)

/**
 * @param {string} directory
 * @param {string} version
 */
async function installApi (directory, version) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { '@opentelemetry/api': version },
  }))
  await execFileAsync('yarn', ['install', '--ignore-scripts', '--non-interactive', '--no-lockfile'], {
    cwd: directory,
    env: { ...process.env, NODE_OPTIONS: '' },
  })
}

/** @param {string} cwd */
async function installTracerApi (cwd) {
  const directory = join(cwd, 'tracer-api')
  await installApi(directory, '1.4.1')
  const destination = join(cwd, 'node_modules/dd-trace/node_modules/@opentelemetry/api')
  await rm(destination, { recursive: true, force: true })
  await cp(join(directory, 'node_modules/@opentelemetry/api'), destination, { recursive: true })
  assert.strictEqual(require(join(destination, 'package.json')).version, '1.4.1')
}

/**
 * @param {string} cwd
 * @param {string} entry
 * @param {string} output
 * @param {'esbuild' | 'webpack'} bundler
 * @param {'commonjs' | 'esm'} format
 * @param {boolean} [externalApi]
 */
async function bundleApplication (cwd, entry, output, bundler, format, externalApi = true) {
  const external = ['dd-trace']
  if (externalApi) external.push('@opentelemetry/api')
  if (bundler === 'esbuild') {
    const esbuild = require(join(cwd, 'node_modules/esbuild'))
    const plugin = require(join(cwd, 'node_modules/dd-trace/esbuild'))
    await esbuild.build({
      absWorkingDir: cwd,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: format === 'commonjs' ? 'cjs' : 'esm',
      outfile: output,
      external,
      plugins: [plugin],
    })
  } else {
    const webpack = require(join(cwd, 'node_modules/webpack'))
    const Plugin = require(join(cwd, 'node_modules/dd-trace/webpack'))
    const compiler = webpack({
      context: cwd,
      mode: 'development',
      target: 'node',
      devtool: false,
      entry,
      output: { path: dirname(output), filename: basename(output) },
      externals: Object.fromEntries(external.map(name => [name, `commonjs ${name}`])),
      plugins: [new Plugin()],
    })
    try {
      const run = promisify(compiler.run.bind(compiler))
      const stats = await run()
      assert.ok(!stats.hasErrors(), stats.toString({ all: false, errors: true }))
    } finally {
      const close = promisify(compiler.close.bind(compiler))
      await close()
    }
  }
}

async function check (agent, proc, timeout, onMessage = () => { }, isMetrics) {
  const messageReceiver = isMetrics
    ? agent.assertTelemetryReceived({ fn: onMessage, requestType: 'generate-metrics', timeout })
    : agent.assertMessageReceived(onMessage, timeout)

  const [res] = await Promise.all([
    messageReceiver,
    /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Process timed out'))
      }, timeout)

      proc
        .on('error', reject)
        .on('exit', (code) => {
          clearTimeout(timer)

          if (code !== 0) {
            reject(new Error(`Process exited with unexpected status code ${code}.`))
          } else {
            resolve()
          }
        })
    })),
  ])

  return res
}

function allEqual (spans, fn) {
  const first = fn(spans[0])
  return spans.every(span => fn(span) === first)
}

function eachEqual (spans, expected, fn) {
  return spans.every((span, i) => fn(span) === expected[i])
}

function nearNow (ts, now = Date.now(), range = 1000) {
  const delta = Math.abs(now - ts)
  return delta < range && delta >= 0
}

// The forked child boots a server on demand; OTEL/SDK init plus dd-trace startup take a
// non-deterministic amount of time. A fixed pre-request delay is either flaky (too short)
// or wasteful (too long); polling until the listener accepts is the cheapest robust way.
async function getWithRetry (url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      return await httpRequest.get(url)
    } catch (err) {
      lastErr = err
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastErr
}

describe('OpenTelemetry API version compatibility', function () {
  this.timeout(20_000)

  for (const apiVersion of OTEL_API_VERSIONS) {
    describe(apiVersion, () => {
      let agent
      let proc
      let cwd
      const timeout = 5000

      useSandbox(
        [`@opentelemetry/api@${apiVersion}`, '@opentelemetry/sdk-trace-node@2.0.1', 'tsx@4.20.6'],
        false,
        ['./integration-tests/opentelemetry/basic.js', './integration-tests/opentelemetry/api.{mjs,ts}']
      )

      before(async function () {
        this.timeout(300_000)
        cwd = sandboxCwd()
        await installTracerApi(cwd)
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        await stopProc(proc)
      })

      after(async () => {
        await agent?.stop()
      })

      it('preserves the native ESM recording, context and propagation baseline', async () => {
        proc = fork(join(cwd, 'api.mjs'), ['provider-first'], { cwd, env: { NATIVE_OTEL: '1' } })
        const [code] = await once(proc, 'exit')
        assert.strictEqual(code, 0)
      })

      for (const format of ['commonjs', 'esm', 'tsx']) {
        for (const order of ['provider-first', 'api-first', 'cached-api-first', 'diag-first']) {
          it(`preserves user API span and propagation behavior (${format}, ${order})`, async () => {
            const installedApiVersion = require(join(cwd, 'node_modules/@opentelemetry/api/package.json')).version
            assert.strictEqual(installedApiVersion, apiVersion)

            const fixture = format === 'commonjs' ? 'basic.js' : `api.${format === 'esm' ? 'mjs' : 'ts'}`
            const execArgv = format === 'commonjs' ? [] : ['--import', 'dd-trace/register.js']
            if (format === 'tsx') execArgv.push('--import', 'tsx')
            proc = fork(join(cwd, fixture), [order], {
              cwd,
              execArgv,
              env: {
                DD_TRACE_AGENT_PORT: agent.port,
                DD_TRACE_STARTUP_LOGS: 'false',
              },
            })

            await check(agent, proc, timeout, ({ payload }) => {
              const trace = payload.find(trace => trace.length === 1 && trace[0].name === 'otel-sub')
              assert.ok(trace)
              assert.strictEqual(trace[0].meta['test.attribute'], 'value')
              assert.strictEqual(trace[0].duration, 50_000_000)
            })
          })
        }
      }
    })
  }
})

describe('OpenTelemetry bundled API', function () {
  this.timeout(60_000)
  let cwd
  let deployed
  let agent
  let proc

  useSandbox([
    `@opentelemetry/api@${latestVersions['@opentelemetry/api']}`,
    '@opentelemetry/sdk-trace-node@2.0.1',
    'esbuild@0.28.2',
    'webpack@5.112.2',
  ], false, ['./integration-tests/opentelemetry/basic.js', './integration-tests/opentelemetry/api.mjs'])

  before(async function () {
    this.timeout(300_000)
    cwd = sandboxCwd()
    await installTracerApi(cwd)
    for (const version of OTEL_API_VERSIONS) {
      const application = join(cwd, `application-${version}`)
      await installApi(application, version)
      await Promise.all(['basic.js', 'api.mjs'].map(fixture => cp(join(cwd, fixture), join(application, fixture))))
    }
    await rm(join(cwd, 'node_modules/@opentelemetry/api'), { recursive: true })
    await cp(join(cwd, 'application-1.9.1/node_modules/@opentelemetry/api'),
      join(cwd, 'node_modules/@opentelemetry/api'), { recursive: true })
    deployed = await mkdtemp(join(tmpdir(), 'dd-otel-bundle-'))
    await mkdir(join(deployed, 'node_modules'))
    await symlink(join(cwd, 'node_modules/dd-trace'), join(deployed, 'node_modules/dd-trace'), 'junction')
    assert.throws(() => createRequire(join(deployed, 'index.js')).resolve('@opentelemetry/api'), {
      code: 'MODULE_NOT_FOUND',
    })
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await stopProc(proc)
  })

  after(async () => {
    await agent?.stop()
    if (deployed) await rm(deployed, { recursive: true, force: true })
  })

  for (const bundler of ['esbuild', 'webpack']) {
    for (const version of OTEL_API_VERSIONS) {
      for (const format of ['commonjs', 'esm']) {
        it(`selects the external application API (${bundler}, ${version}, ${format})`, async () => {
          const application = join(cwd, `application-${version}`)
          const entry = join(application, format === 'commonjs' ? 'basic.js' : 'api.mjs')
          const output = `${bundler}-${version}-${format}.${bundler === 'esbuild' && format === 'esm' ? 'mjs' : 'cjs'}`
          await bundleApplication(cwd, entry, join(deployed, output), bundler, format)

          const deployedApi = join(deployed, 'node_modules/@opentelemetry/api')
          await rm(deployedApi, { recursive: true, force: true })
          await cp(join(application, 'node_modules/@opentelemetry/api'), deployedApi, { recursive: true })
          assert.strictEqual(JSON.parse(await readFile(join(deployedApi, 'package.json'), 'utf8')).version, version)
          proc = fork(join(deployed, output), ['provider-first'], {
            cwd: deployed,
            env: { DD_TRACE_AGENT_PORT: agent.port, DD_TRACE_STARTUP_LOGS: 'false' },
          })
          await check(agent, proc, 5000, ({ payload }) => {
            assert.ok(payload.some(trace => trace.some(span => span.name === 'otel-sub')))
          })
        })
      }
    }
  }

  for (const bundler of ['esbuild', 'webpack']) {
    it(`preserves an embedded API's native exports (${bundler})`, async () => {
      const entry = join(cwd, 'application-1.9.1/native-exports.cjs')
      await writeFile(entry, `
        const assert = require('node:assert/strict')
        const tracer = require('dd-trace').init()
        const api = require('@opentelemetry/api')
        assert.equal(api.trace.getTracer('native').startSpan('noop').isRecording(), false)
        assert.equal(api.context.active(), api.ROOT_CONTEXT)
        tracer.trace('native-bundled-api', span => {
          const carrier = {}
          tracer.inject(span.context(), 'text_map', carrier)
          assert.equal(carrier['x-datadog-trace-id'], span.context().toTraceId())
        })
      `)
      const output = join(deployed, `${bundler}-native-exports.cjs`)
      await bundleApplication(cwd, entry, output, bundler, 'commonjs', false)
      proc = fork(output, [], {
        cwd: deployed,
        env: { DD_TRACE_AGENT_PORT: agent.port, DD_TRACE_STARTUP_LOGS: 'false' },
      })
      await check(agent, proc, 5000, ({ payload }) => {
        assert.ok(payload.some(trace => trace.some(span => span.name === 'native-bundled-api')))
      })
    })
  }

  it('uses the application API when the tracer copy is absent', async () => {
    await rm(join(cwd, 'node_modules/dd-trace/node_modules/@opentelemetry/api'), { recursive: true })
    proc = fork(join(cwd, 'basic.js'), ['provider-first'], {
      cwd,
      env: { DD_TRACE_AGENT_PORT: agent.port, DD_TRACE_STARTUP_LOGS: 'false' },
    })
    await check(agent, proc, 5000, ({ payload }) => {
      assert.ok(payload.some(trace => trace.some(span => span.name === 'otel-sub')))
    })
  })

  it('preserves native tracing when both API copies are absent', async () => {
    await rm(join(cwd, 'node_modules/dd-trace/node_modules/@opentelemetry/api'), { recursive: true, force: true })
    await rm(join(cwd, 'node_modules/@opentelemetry/api'), { recursive: true })
    const filename = join(cwd, 'native.cjs')
    await writeFile(filename, `
      const assert = require('node:assert/strict')
      const tracer = require('dd-trace').init()
      assert.throws(() => tracer.TracerProvider, { code: 'MODULE_NOT_FOUND' })
      tracer.trace('native-without-otel', span => {
        const carrier = {}
        tracer.inject(span.context(), 'text_map', carrier)
        assert.equal(carrier['x-datadog-trace-id'], span.context().toTraceId())
      })
    `)
    proc = fork(filename, [], {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_LOGS_OTEL_ENABLED: 'true',
        DD_METRICS_OTEL_ENABLED: 'true',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
      },
    })
    await check(agent, proc, 5000, ({ payload }) => {
      assert.ok(payload.some(trace => trace.some(span => span.name === 'native-without-otel')))
    })
  })
})

for (const [sdkVersion, apiVersion] of [
  ['0.222.0', '1.9.1'],
  [latestVersions['@opentelemetry/sdk-node'], latestVersions['@opentelemetry/api']],
]) {
  describe(`OpenTelemetry SDK provider (${sdkVersion})`, function () {
    this.timeout(20_000)

    let agent
    let proc
    let cwd

    useSandbox([`@opentelemetry/sdk-node@${sdkVersion}`, `@opentelemetry/api@${apiVersion}`])

    before(async function () {
      cwd = sandboxCwd()
      const { engines } = require(join(cwd, 'node_modules/@opentelemetry/sdk-node/package.json'))
      if (!semver.satisfies(process.versions.node, engines.node)) {
        // SDK releases can require a newer runtime than the tracer.
        this.skip()
      }
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
    })

    after(async () => {
      await agent?.stop()
    })

    for (const format of ['commonjs', 'esm']) {
      it(`delivers spans to the tracer and user processor with ${format}`, async () => {
        const fixture = format === 'esm'
          ? 'opentelemetry/fixtures/sdk-node-span-processor.mjs'
          : 'opentelemetry/sdk-node-span-processor.js'
        proc = fork(join(cwd, fixture), {
          cwd,
          execArgv: format === 'esm' ? ['--loader=dd-trace/loader-hook.mjs'] : [],
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_TRACE_OTEL_ENABLED: '1',
            DD_INJECT_FORCE: process.env.DD_INJECT_FORCE,
          },
        })

        await check(agent, proc, 5000, ({ payload }) => {
          const trace = payload.find(trace => trace.length === 1 && trace[0].name === 'otel-sub')
          assert.ok(trace)
        })
      })
    }
  })
}

describe('opentelemetry', function () {
  this.timeout(20_000)

  let agent = /** @type {FakeAgent | null} */ (null)
  let proc
  let cwd = /** @type {string} */ ('')
  const timeout = 5000
  const dependencies = [
    '@opentelemetry/api',
    '@opentelemetry/instrumentation',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-express@0.47.1',
    'express@4', // TODO: Remove pinning once our tests support Express v5
    '@opentelemetry/sdk-node',
    // Needed because sdk-node doesn't start a tracer without an exporter
    '@opentelemetry/exporter-jaeger',
  ]

  useSandbox(dependencies)

  before(async function () {
    cwd = sandboxCwd()
    const { engines } = require(join(cwd, 'node_modules/@opentelemetry/sdk-node/package.json'))
    if (!semver.satisfies(process.versions.node, engines.node)) {
      // SDK releases can require a newer runtime than the tracer.
      this.skip()
    }
    agent = await new FakeAgent().start()
  })

  after(async () => {
    await stopProc(proc)
    await agent?.stop()
  })

  it("should not capture telemetry DD and OTEL vars don't conflict", async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
        DD_SERVICE: 'service',
        DD_TRACE_LOG_LEVEL: 'error',
        DD_TRACE_SAMPLE_RATE: '0.5',
        DD_TRACE_ENABLED: 'true',
        DD_RUNTIME_METRICS_ENABLED: 'true',
        DD_TAGS: 'foo:bar,baz:qux',
        DD_TRACE_PROPAGATION_STYLE: 'datadog',
      },
    })

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload
      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.strictEqual(otelHiding.length, 0)
      assert.strictEqual(otelInvalid.length, 0)
    }, true)
  })

  it('should capture telemetry if both DD and OTEL env vars are set', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
        DD_SERVICE: 'service',
        OTEL_SERVICE_NAME: 'otel_service',
        DD_TRACE_LOG_LEVEL: 'error',
        OTEL_LOG_LEVEL: 'debug',
        DD_TRACE_SAMPLE_RATE: '0.5',
        OTEL_TRACES_SAMPLER: 'traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '1.0',
        DD_TRACE_ENABLED: 'true',
        OTEL_TRACES_EXPORTER: 'none',
        DD_RUNTIME_METRICS_ENABLED: 'true',
        OTEL_METRICS_EXPORTER: 'none',
        DD_TAGS: 'foo:bar,baz:qux',
        OTEL_RESOURCE_ATTRIBUTES: 'foo+bar13baz+qux1',
        DD_TRACE_PROPAGATION_STYLE: 'datadog, tracecontext',
        OTEL_PROPAGATORS: 'datadog, tracecontext',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_SDK_DISABLED: 'false',
      },
    })

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.deepStrictEqual(sortMetricTags(otelHiding), sortMetricTags([
        ['config_datadog:dd_trace_log_level', 'config_opentelemetry:otel_log_level'],
        ['config_datadog:dd_trace_propagation_style', 'config_opentelemetry:otel_propagators'],
        ['config_datadog:dd_service', 'config_opentelemetry:otel_service_name'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler_arg'],
        ['config_datadog:dd_trace_enabled', 'config_opentelemetry:otel_traces_exporter'],
        ['config_datadog:dd_runtime_metrics_enabled', 'config_opentelemetry:otel_metrics_exporter'],
        ['config_datadog:dd_tags', 'config_opentelemetry:otel_resource_attributes'],
        ['config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'],
      ]))

      assert.deepStrictEqual(sortMetricTags(otelInvalid), [])

      for (const metric of otelHiding) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should capture telemetry when OTEL env vars are invalid', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
        OTEL_SERVICE_NAME: 'otel_service',
        OTEL_LOG_LEVEL: 'foo',
        OTEL_TRACES_SAMPLER: 'foo',
        OTEL_TRACES_SAMPLER_ARG: 'foo',
        OTEL_TRACES_EXPORTER: 'foo',
        OTEL_METRICS_EXPORTER: 'foo',
        OTEL_RESOURCE_ATTRIBUTES: 'foo',
        OTEL_PROPAGATORS: 'foo',
        OTEL_LOGS_EXPORTER: 'foo',
        OTEL_SDK_DISABLED: 'foo',
      },
    })

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.deepStrictEqual(sortMetricTags(otelHiding), sortMetricTags([
        ['config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'],
      ]))

      assert.deepStrictEqual(sortMetricTags(otelInvalid), sortMetricTags([
        ['config_datadog:dd_trace_log_level', 'config_opentelemetry:otel_log_level'],
        ['config_datadog:dd_trace_propagation_style', 'config_opentelemetry:otel_propagators'],
        ['config_opentelemetry:otel_logs_exporter'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler_arg'],
        ['config_datadog:dd_trace_enabled', 'config_opentelemetry:otel_traces_exporter'],
        ['config_datadog:dd_runtime_metrics_enabled', 'config_opentelemetry:otel_metrics_exporter'],
        ['config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'],
      ]))

      for (const metric of otelInvalid) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should start a trace in isolation', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
      },
    })
    await check(agent, proc, timeout, ({ payload }) => {
      // Should have a single trace with a single span
      assert.strictEqual(payload.length, 1)
      const [trace] = payload
      assert.strictEqual(trace.length, 1)
      const [span] = trace

      // Should be the expected otel span
      assert.strictEqual(span.name, 'otel-sub')
    })
  })

  it('should capture telemetry', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
      },
    })

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload
      assert.strictEqual(metrics.namespace, 'tracers')

      const spanCreated = metrics.series.find(({ metric }) => metric === 'spans_created')
      const spanFinished = metrics.series.find(({ metric }) => metric === 'spans_finished')

      // Validate common fields between start and finish
      for (const series of [spanCreated, spanFinished]) {
        assert.ok(series)

        assert.strictEqual(series.points.length, 1)
        assert.strictEqual(series.points[0].length, 2)

        const [ts, value] = series.points[0]
        assert.ok(nearNow(ts, Date.now() / 1e3))
        assert.strictEqual(value, 1)

        assert.strictEqual(series.type, 'count')
        assert.strictEqual(series.common, true)
        assert.deepStrictEqual(series.tags, [
          'integration_name:otel',
          'otel_enabled:true',
        ])
      }
    }, true)
  })

  it('should capture auto-instrumentation telemetry', async () => {
    const SERVER_PORT = 6666
    proc = fork(join(cwd, 'opentelemetry/auto-instrumentation.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        SERVER_PORT,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
      },
    })
    await getWithRetry(`http://localhost:${SERVER_PORT}/first-endpoint`, 10_000)

    await check(agent, proc, 10_000, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload
      assert.strictEqual(metrics.namespace, 'tracers')

      const spanCreated = metrics.series.find(({ metric }) => metric === 'spans_created')
      const spanFinished = metrics.series.find(({ metric }) => metric === 'spans_finished')

      // Validate common fields between start and finish
      for (const series of [spanCreated, spanFinished]) {
        assert.ok(series)

        assert.strictEqual(series.points.length, 1)
        assert.strictEqual(series.points[0].length, 2)

        const [ts, value] = series.points[0]
        assert.ok(nearNow(ts, Date.now() / 1e3))
        assert.strictEqual(value, 9)

        assert.strictEqual(series.type, 'count')
        assert.strictEqual(series.common, true)
        assert.deepStrictEqual(series.tags, [
          'integration_name:otel.library',
          'otel_enabled:true',
        ])
      }
    }, true)
  })

  it('should work within existing datadog-traced http request', async () => {
    proc = fork(join(cwd, 'opentelemetry/server.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
      },
    })
    await check(agent, proc, timeout, ({ payload }) => {
      // Should have three spans
      const [trace] = payload
      assert.strictEqual(trace.length, 3)

      // Should have expected span names and ordering
      assert.strictEqual(eachEqual(trace, ['web.request', 'otel-sub', 'dd-sub'], span => span.name), true)

      // Should have matching trace ids
      assert.ok(allEqual(trace, span => span.trace_id.toString()))

      // Should have matching service names
      assert.strictEqual(allEqual(trace, span => span.service), true)

      // Should have expected span parentage
      const [webSpan, otelSpan, ddSpan] = trace
      assert.strictEqual(otelSpan.parent_id.toString(), webSpan.span_id.toString())
      assert.strictEqual(ddSpan.parent_id.toString(), otelSpan.span_id.toString())
    })
  })

  it('should work with otel express & http auto instrumentation', async () => {
    const SERVER_PORT = 6666
    const signal = AbortSignal.timeout(10_000)
    const messages = []
    const onTraces = messages.push.bind(messages)
    agent.on('otlp-traces', onTraces)
    try {
      proc = fork(join(cwd, 'opentelemetry/auto-instrumentation.js'), {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent?.port,
          DD_TRACE_OTEL_ENABLED: '1',
          SERVER_PORT,
          DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net',
          DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${agent.port}/v1/traces`,
        },
      })
      const [[code]] = await Promise.all([
        once(proc, 'exit', { signal }),
        getWithRetry(`http://localhost:${SERVER_PORT}/first-endpoint`, 10_000),
      ])
      assert.strictEqual(code, 0)
    } finally {
      agent.removeListener('otlp-traces', onTraces)
    }
    assert.strictEqual(messages.length, 2)
    for (const { headers } of messages) {
      assert.strictEqual(headers['content-type'], 'application/json')
    }
    const trace = messages.flatMap(({ payload }) => payload.resourceSpans
      .flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)))
    assert.strictEqual(trace.length, 9)

    // Should have expected span resource names and ordering
    assert.ok(eachEqual(trace, [
      'GET /second-endpoint',
      'middleware - query',
      'middleware - expressInit',
      'request handler - /second-endpoint',
      'GET /first-endpoint',
      'middleware - query',
      'middleware - expressInit',
      'request handler - /first-endpoint',
      'GET',
    ],
    (span) => span.name))

    assert.ok(allEqual(trace, span => span.traceId))

    const [get3, query2, init2, handler2, get1, query1, init1, handler1, get2] = trace
    for (const [child, parent] of [
      [query1, get1],
      [init1, get1],
      [handler1, get1],
      [get2, get1],
      [get3, get2],
      [query2, get3],
      [init2, get3],
      [handler2, get3],
    ]) {
      assert.notStrictEqual(child.spanId, parent.spanId)
      assert.strictEqual(child.parentSpanId, parent.spanId)
    }
  })

  it('should auto-instrument @opentelemetry/sdk-node', async () => {
    proc = fork(join(cwd, 'opentelemetry/env-var.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
      },
    })
    await check(agent, proc, timeout, ({ payload }) => {
      const trace = payload.find(trace => trace.length === 1 && trace[0].name === 'otel-sub')
      assert.ok(trace)
    })
  })
})

function sortMetricTags (metrics) {
  return metrics
    .map(metric => Array.isArray(metric) ? metric : metric.tags)
    .sort((a, b) => a.join(',').localeCompare(b.join(',')))
}
