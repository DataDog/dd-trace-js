'use strict'

const { execFile } = require('node:child_process')
const { cp, mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises')
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
const apiDirectory = dirname(extractPackageAndModulePath(apiMain).pkgJson)
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

  for (const mode of ['esm', 'eval']) {
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
      assert.equal(Object.keys(require.cache).some(filename => filename.includes('/@opentelemetry/api/')), false)
      ${nativeSpan}
    `)
  })

  for (const [name, contents, expectedCode] of [
    ['missing transitive dependency', "require('missing-otel-api-dependency')", 'MODULE_NOT_FOUND'],
    ['module evaluation error', "throw Object.assign(new Error('application API failed'), { code: 'API_FAILED' })",
      'API_FAILED'],
  ]) {
    it(`does not replace an application API with a ${name}`, async () => {
      const applicationApi = await installApi()
      await writeFile(join(applicationApi, apiEntrypoint), contents)
      await run(`
        const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
        assert.throws(() => tracer.TracerProvider, { code: '${expectedCode}' })
        ${nativeSpan}
      `)
    })
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

  it('does not replace an application API with an inaccessible package export', async () => {
    const applicationApi = await installApi()
    await writeFile(join(applicationApi, 'package.json'), JSON.stringify({
      name: '@opentelemetry/api',
      version: '1.10.0',
      exports: { './other': './other.js' },
    }))
    await run(`
      const tracer = require('dd-trace').init({ plugins: false, runtimeMetrics: false })
      assert.throws(() => tracer.TracerProvider, { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
      ${nativeSpan}
    `)
  })
})
