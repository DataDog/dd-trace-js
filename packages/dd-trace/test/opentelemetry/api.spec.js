'use strict'

const { execFile } = require('node:child_process')
const { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve } = require('node:path')
const { promisify } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')

const extractPackageAndModulePath = require(
  '../../../datadog-instrumentations/src/helpers/extract-package-and-module-path'
)

const execFileAsync = promisify(execFile)
const tracerDirectory = resolve(__dirname, '../../../..')
const apiMain = require.resolve('@opentelemetry/api')
const apiDirectory = dirname(/** @type {string} */ (extractPackageAndModulePath(apiMain.replaceAll('\\', '/')).pkgJson))
const apiEntrypoint = relative(apiDirectory, apiMain)
const nativeSpan = `
  tracer.trace('native', span => {
    const carrier = {}
    tracer.inject(span.context(), 'text_map', carrier)
    assert.equal(carrier['x-datadog-trace-id'], span.context().toTraceId())
  })
`
const recordingSpan = `
  const provider = new tracer.TracerProvider()
  provider.register()
  const api = require(applicationApi)
  const parent = api.propagation.extract(api.ROOT_CONTEXT, {
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    tracestate: 'vendor=value'
  })
  api.context.with(parent, () => {
    api.trace.getTracer('application').startActiveSpan('application', span => {
      assert.equal(span.isRecording(), true)
      assert.equal(api.trace.getSpan(api.context.active()), span)
      assert.equal(span.spanContext().traceState.serialize().includes('vendor=value'), true)
      assert.equal(Object.getPrototypeOf(span.spanContext().traceState),
        Object.getPrototypeOf(api.createTraceState()))
      span.end()
    })
  })
`

describe('OpenTelemetry application API selection', () => {
  let directory

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dd-otel-api-'))
    await mkdir(join(directory, 'node_modules'))
    await symlink(tracerDirectory, join(directory, 'node_modules/dd-trace'), 'junction')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  /** @param {string} [name] */
  async function installApi (name = 'node_modules/@opentelemetry/api') {
    const destination = join(directory, name)
    await cp(apiDirectory, destination, { recursive: true })
    return destination
  }

  /**
   * @param {string} source
   * @param {Record<string, string>} [env]
   * @param {'commonjs'|'esm'|'eval'} [mode]
   */
  async function run (source, env = {}, mode = 'commonjs') {
    const filename = join(directory, mode === 'esm' ? 'application.mjs' : 'application.cjs')
    const script = `
      'use strict'
      ${mode === 'esm'
        ? `import { createRequire } from 'node:module'
          const require = createRequire(import.meta.url)`
        : ''}
      const assert = require('node:assert/strict')
      ${source}
    `
    await writeFile(filename, script)
    await execFileAsync(process.execPath, mode === 'eval' ? ['--eval', script] : [filename], {
      cwd: mode === 'eval' ? directory : tmpdir(),
      env: {
        ...process.env,
        DD_TRACE_AGENT_URL: 'http://127.0.0.1:1',
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        ...env,
      },
    })
  }

  for (const mode of /** @type {const} */ (['esm', 'eval'])) {
    it(`finds an application API without a CommonJS main module (${mode})`, async () => {
      await installApi()
      await run(`
        const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
        const applicationApi = '@opentelemetry/api'
        ${recordingSpan}
      `, {}, mode)
    })
  }

  for (const order of ['provider-first', 'cached-api-first', 'api-first', 'diag-first']) {
    it(`uses the application API with a different working directory (${order})`, async () => {
      await installApi()
      await run(`
        const applicationApi = '@opentelemetry/api'
        ${order === 'cached-api-first' ? 'require(applicationApi)' : ''}
        const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
        ${order === 'api-first' || order === 'diag-first' ? 'require(applicationApi)' : ''}
        ${order === 'diag-first' ? 'require(applicationApi).diag.setLogger(console)' : ''}
        ${recordingSpan}
      `)
    })
  }

  it('uses an intercepted API outside the entrypoint dependency tree', async () => {
    const applicationApi = await installApi('dependency/node_modules/@opentelemetry/api')
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      const applicationApi = ${JSON.stringify(applicationApi)}
      require('node:module').createRequire(applicationApi + '/package.json')('@opentelemetry/api')
      ${recordingSpan}
    `)
  })

  it('finds the version of an application API linked outside node_modules', async () => {
    const applicationApi = await installApi('linked-api')
    await mkdir(join(directory, 'node_modules/@opentelemetry'))
    await symlink(applicationApi, join(directory, 'node_modules/@opentelemetry/api'), 'junction')
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      const applicationApi = '@opentelemetry/api'
      ${recordingSpan}
    `)
  })

  for (const mode of /** @type {const} */ (['commonjs', 'esm', 'eval'])) {
    it(`uses the entrypoint API ahead of an intercepted dependency API (${mode})`, async () => {
      const [, dependencyApi] = await Promise.all([
        installApi(),
        installApi('dependency/node_modules/@opentelemetry/api'),
      ])
      await run(`
        const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
        require('node:module')
          .createRequire(${JSON.stringify(join(dependencyApi, 'package.json'))})('@opentelemetry/api')
        const applicationApi = '@opentelemetry/api'
        ${recordingSpan}
      `, {}, mode)
    })
  }

  it('retains the tracer API as a fallback when the application has none', async () => {
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      const applicationApi = ${JSON.stringify(apiMain)}
      ${recordingSpan}
    `)
  })

  it('does not load an API for native tracing', async () => {
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      assert.equal(Object.keys(require.cache).some(filename =>
        filename.replaceAll('\\\\', '/').includes('/@opentelemetry/api/')), false)
      ${nativeSpan}
    `)
  })

  it('preserves the missing optional API error when no copy is available', async () => {
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      const Module = require('node:module')
      const resolveFilename = Module._resolveFilename
      Module._resolveFilename = function (request) {
        if (request === '@opentelemetry/api') {
          throw Object.assign(new Error("Cannot find module '@opentelemetry/api'"), { code: 'MODULE_NOT_FOUND' })
        }
        return resolveFilename.apply(this, arguments)
      }
      assert.throws(() => tracer.TracerProvider, { code: 'MODULE_NOT_FOUND' })
      Module._resolveFilename = resolveFilename
      ${nativeSpan}
    `)
  })

  it('preserves registration through an API with an unsupported major', async () => {
    const dependencyApi = await installApi()
    const packageFile = join(dependencyApi, 'package.json')
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'))
    await writeFile(packageFile, JSON.stringify({ ...metadata, version: '2.0.0' }))
    for (const filename of ['version.cjs', 'internal/global-utils.cjs']) {
      const versionFile = join(dependencyApi, dirname(apiEntrypoint), filename)
      const versionSource = await readFile(versionFile, 'utf8')
      await writeFile(versionFile, versionSource.replaceAll(metadata.version, '2.0.0'))
    }
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      new tracer.TracerProvider().register()
      const api = require(${JSON.stringify(dependencyApi)})
      const provider = { getMeter () { return { marker: 'independent' } } }
      assert.equal(api.metrics.setGlobalMeterProvider(provider), true)
      assert.equal(api.metrics.getMeter('unsupported').marker, 'independent')
      assert.equal(globalThis[Symbol.for('opentelemetry.js.api.1')]?.metrics, undefined)
    `)
  })

  it('uses a configured propagator through the selected API', async () => {
    await installApi()
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      const api = require('@opentelemetry/api')
      const propagator = {
        inject (context, carrier, setter) { setter.set(carrier, 'custom', 'value') },
        extract (context) { return context },
        fields () { return ['custom'] }
      }
      new tracer.TracerProvider().register({ propagator })
      const carrier = {}
      api.propagation.inject(api.context.active(), carrier)
      assert.deepEqual(carrier, { custom: 'value' })
    `)
  })

  it('refreshes baggage in a retained native span context', async () => {
    await installApi()
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      new tracer.TracerProvider().register()
      const api = require('@opentelemetry/api')
      tracer.trace('native', span => {
        const retained = api.context.active()
        api.context.with(retained, () => {
          assert.equal(api.context.active(), retained)
          tracer.setBaggageItem('customer', 'value')
          assert.equal(api.propagation.getActiveBaggage().getEntry('customer').value, 'value')
          assert.equal(api.trace.getSpan(api.context.active()), api.trace.getSpan(retained))
        })
      })
    `)
  })

  it('exposes native baggage before retaining an OpenTelemetry context', async () => {
    await installApi()
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      new tracer.TracerProvider().register()
      const api = require('@opentelemetry/api')
      tracer.trace('native', () => {
        tracer.setBaggageItem('customer', 'value')
        assert.equal(api.propagation.getActiveBaggage().getEntry('customer').value, 'value')
        assert.equal(api.trace.getActiveSpan().isRecording(), true)
      })
    `)
  })

  it('preserves a later explicit Datadog tracer provider registration', async () => {
    await installApi()
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      new tracer.TracerProvider().register()
      let ended = 0
      const provider = new tracer.TracerProvider({ spanProcessors: [{
        onStart () {}, onEnd () { ended++ }, shutdown () {}, forceFlush () {}
      }] })
      provider.register()
      require('@opentelemetry/api').trace.getTracer('replacement').startSpan('span').end()
      assert.equal(ended, 1)
    `)
  })

  it('does not load a configured API path for native tracing', async () => {
    await run(`
      const tracer = require('dd-trace').init({
        plugins: false, runtimeMetrics: false, otelApiPath: '/missing/otel-api.cjs'
      })
      ${nativeSpan}
    `)
  })

  it('preserves an explicit API path resolution failure', async () => {
    await run(`
      const tracer = require('dd-trace').init({
        plugins: false, runtimeMetrics: false, otelApiPath: '/missing/otel-api.cjs'
      })
      assert.throws(() => tracer.TracerProvider, { code: 'MODULE_NOT_FOUND' })
      ${nativeSpan}
    `)
  })

  for (const [name, contents, expectedCode] of [
    ['missing transitive dependency', "require('missing-otel-api-dependency')", 'MODULE_NOT_FOUND'],
    ['module evaluation error', "throw Object.assign(new Error('application API failed'), { code: 'API_FAILED' })",
      'API_FAILED'],
  ]) {
    for (const preloadDependency of [false, true]) {
      it(`does not replace an application API with a ${name} (dependency: ${preloadDependency})`, async () => {
        const applicationApi = await installApi()
        const dependencyApi = preloadDependency
          ? await installApi('dependency/node_modules/@opentelemetry/api')
          : undefined
        await writeFile(join(applicationApi, apiEntrypoint), contents)
        await run(`
          const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
          ${dependencyApi
            ? `require('node:module')
              .createRequire(${JSON.stringify(join(dependencyApi, 'package.json'))})('@opentelemetry/api')`
            : ''}
          assert.throws(() => tracer.TracerProvider, { code: '${expectedCode}' })
          ${nativeSpan}
        `)
      })
    }
  }

  for (const [signal, runtimeMetrics] of [['LOGS', false], ['METRICS', false], ['METRICS', true]]) {
    it(`preserves native tracing after ${signal} startup fails (runtime: ${runtimeMetrics})`, async () => {
      const applicationApi = await installApi()
      await writeFile(join(applicationApi, apiEntrypoint), "require('missing-otel-api-dependency')")
      await run(`
        const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: ${runtimeMetrics} })
        ${nativeSpan}
      `, { [`DD_${signal}_OTEL_ENABLED`]: 'true', [`OTEL_${signal}_EXPORTER`]: 'otlp' })
    })
  }

  for (const preloadDependency of [false, true]) {
    it(`preserves an inaccessible application API export error (dependency: ${preloadDependency})`, async () => {
      const applicationApi = await installApi()
      const dependencyApi = preloadDependency
        ? await installApi('dependency/node_modules/@opentelemetry/api')
        : undefined
      await writeFile(join(applicationApi, 'package.json'), JSON.stringify({
        name: '@opentelemetry/api',
        version: '1.10.0',
        exports: { './other': './other.js' },
      }))
      await run(`
        const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
        ${dependencyApi
          ? `require('node:module')
            .createRequire(${JSON.stringify(join(dependencyApi, 'package.json'))})('@opentelemetry/api')`
          : ''}
        assert.throws(() => tracer.TracerProvider, { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
        ${nativeSpan}
      `)
    })
  }
})
