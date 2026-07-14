'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, afterEach } = require('mocha')

const DD_TRACE_PATH = path.join(__dirname, '..', '..', '..', '..')
const API_OWNER_VERSION = require(path.join(DD_TRACE_PATH, 'package.json')).dependencies['@opentelemetry/api']
const API_DIRECTORY = findPackageDirectory(require.resolve('@opentelemetry/api-v1'))
const API_LOGS_DIRECTORIES = [
  findPackageDirectory(require.resolve('@opentelemetry/api-logs-v033')),
  findPackageDirectory(require.resolve('@opentelemetry/api-logs-v034')),
]

describe('OpenTelemetry API copy loading', () => {
  const temporaryDirectories = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  for (const format of ['commonjs', 'module']) {
    for (const apiLogsDirectory of API_LOGS_DIRECTORIES) {
      const apiLogsVersion = require(path.join(apiLogsDirectory, 'package.json')).version
      it(`keeps providers visible to late ${format} API 1.0.0 and API Logs ${apiLogsVersion}`, () => {
        const applicationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-api-loading-'))
        temporaryDirectories.push(applicationDirectory)
        fs.writeFileSync(path.join(applicationDirectory, 'package.json'), JSON.stringify({
          name: 'otel-api-loading-test',
          private: true,
        }))

        const customDirectory = path.join(applicationDirectory, 'custom')
        copyPackage(API_DIRECTORY, customDirectory, '@opentelemetry/api')
        copyPackage(apiLogsDirectory, customDirectory, '@opentelemetry/api-logs')
        const loader = writeLoader(customDirectory, format)
        const entry = path.join(applicationDirectory, 'app.cjs')
        fs.writeFileSync(entry, applicationSource(loader, format))

        const args = []
        if (format === 'module') {
          args.push('--loader', path.join(DD_TRACE_PATH, 'initialize.mjs'))
        }
        args.push(entry)
        const output = execFileSync(process.execPath, args, {
          cwd: applicationDirectory,
          encoding: 'utf8',
          env: {
            ...process.env,
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
            DD_LOGS_OTEL_ENABLED: 'true',
            DD_METRICS_OTEL_ENABLED: 'true',
            DD_REMOTE_CONFIG_ENABLED: 'false',
            DD_RUNTIME_METRICS_ENABLED: 'false',
            DD_TRACE_ENABLED: 'true',
            NODE_OPTIONS: '',
            OTEL_LOGS_EXPORTER: '',
            OTEL_METRICS_EXPORTER: 'otlp',
            OTEL_TRACES_EXPORTER: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        })

        assert.match(output, /OTEL_API_COPY_OK/)
      })
    }
  }

  it('adopts a compatible global created by API 1.0.0 diagnostics before registration', () => {
    const applicationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-api-preloaded-'))
    temporaryDirectories.push(applicationDirectory)
    fs.writeFileSync(path.join(applicationDirectory, 'package.json'), JSON.stringify({
      name: 'otel-api-preloaded-test',
      private: true,
    }))

    const customDirectory = path.join(applicationDirectory, 'custom')
    copyPackage(API_DIRECTORY, customDirectory, '@opentelemetry/api')
    copyPackage(API_LOGS_DIRECTORIES[0], customDirectory, '@opentelemetry/api-logs')
    const loader = writeLoader(customDirectory, 'commonjs')
    const entry = path.join(applicationDirectory, 'app.cjs')
    fs.writeFileSync(entry, preloadedApplicationSource(loader))

    const output = execFileSync(process.execPath, [entry], {
      cwd: applicationDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_LOGS_OTEL_ENABLED: 'false',
        DD_METRICS_OTEL_ENABLED: 'true',
        DD_REMOTE_CONFIG_ENABLED: 'false',
        DD_RUNTIME_METRICS_ENABLED: 'false',
        DD_TRACE_ENABLED: 'true',
        NODE_OPTIONS: '',
        OTEL_LOGS_EXPORTER: '',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_TRACES_EXPORTER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })

    assert.match(output, /OTEL_PRELOADED_GLOBAL_OK/)
  })
})

/**
 * @param {string} source
 * @param {string} customDirectory
 * @param {string} packageName
 */
function copyPackage (source, customDirectory, packageName) {
  const destination = path.join(customDirectory, 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}

/**
 * @param {string} customDirectory
 * @param {string} format
 * @returns {string}
 */
function writeLoader (customDirectory, format) {
  if (format === 'module') {
    const loader = path.join(customDirectory, 'load-api.mjs')
    fs.writeFileSync(loader, `
import * as api from '@opentelemetry/api'
import * as apiLogs from '@opentelemetry/api-logs'
export { api, apiLogs }
`)
    return loader
  }

  const loader = path.join(customDirectory, 'load-api.cjs')
  fs.writeFileSync(loader, `
module.exports = {
  api: require('@opentelemetry/api'),
  apiLogs: require('@opentelemetry/api-logs')
}
`)
  return loader
}

/**
 * @param {string} applicationLoader
 * @param {string} format
 * @returns {string}
 */
function applicationSource (applicationLoader, format) {
  const load = format === 'module'
    ? `import(require('node:url').pathToFileURL(${JSON.stringify(applicationLoader)}))`
    : `require(${JSON.stringify(applicationLoader)})`

  return `'use strict'
const holder = require(${JSON.stringify(path.join(DD_TRACE_PATH, 'packages/dd-trace/src/opentelemetry/api'))})
const tracer = require(${JSON.stringify(DD_TRACE_PATH)}).init({ startupLogs: false })
const provider = new tracer.TracerProvider()
provider.register()
const ownerApi = holder.getApiOwner()
const ownerApiLogs = holder.getApiLogsOwner()
const tracerProvider = ownerApi.trace.getTracerProvider()
const meterProvider = ownerApi.metrics.getMeterProvider()
const loggerProvider = ownerApiLogs.logs.getLoggerProvider()

async function main () {
  const { api, apiLogs } = await ${load}
  if (api.trace.getTracerProvider().getDelegate?.() !== provider) {
    throw new Error('Application API copy did not receive the tracer provider')
  }
  if (ownerApi.trace.getTracerProvider() !== tracerProvider) {
    throw new Error('Late capture replaced the fallback tracer provider')
  }
  if (ownerApi.metrics.getMeterProvider() !== meterProvider || !meterProvider.reader) {
    throw new Error('Late capture replaced the fallback meter provider')
  }
  if (ownerApiLogs.logs.getLoggerProvider() !== loggerProvider || !loggerProvider.processor) {
    throw new Error('Late capture replaced the fallback logger provider')
  }
  if (apiLogs.logs.getLoggerProvider() !== loggerProvider) {
    throw new Error('Application Logs API copy did not receive the logger provider')
  }

  const contextKey = api.createContextKey('late-api-copy')
  const context = api.ROOT_CONTEXT.setValue(contextKey, 'active')
  api.context.with(context, () => {
    if (api.context.active().getValue(contextKey) !== 'active') {
      throw new Error('Application API copy did not receive the context manager')
    }
  })

  const span = api.trace.getTracer('copy-test').startSpan('copy-test')
  const traceId = span.spanContext().traceId
  const carrier = {}
  api.propagation.inject(api.trace.setSpan(context, span), carrier)
  let diagnosticMessage
  const originalDiagnosticError = api.diag.error
  api.diag.error = message => {
    diagnosticMessage = message
  }
  span.end()
  span.end()
  api.diag.error = originalDiagnosticError
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
    throw new Error('OpenTelemetry bridge returned an invalid trace ID: ' + traceId)
  }
  if (!carrier.traceparent) {
    throw new Error('Application API copy did not receive the propagator')
  }
  if (diagnosticMessage !== 'You can only call end() on a span once.') {
    throw new Error('Bridge diagnostics did not use the late application API copy')
  }
  if (holder.getApi().trace !== api.trace || holder.getApiLogs().logs !== apiLogs.logs) {
    throw new Error('Late application copies did not become the canonical snapshot')
  }

  console.log('OTEL_API_COPY_OK')
  process.exit(0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
`
}

/**
 * @param {string} applicationLoader
 * @returns {string}
 */
function preloadedApplicationSource (applicationLoader) {
  return `'use strict'
const holder = require(${JSON.stringify(path.join(DD_TRACE_PATH, 'packages/dd-trace/src/opentelemetry/api'))})
holder.getApiOwner()
const { api } = require(${JSON.stringify(applicationLoader)})
const diagnosticLogger = {
  error () {},
  warn () {},
  info () {},
  debug () {},
  verbose () {},
}
api.diag.setLogger(diagnosticLogger, api.DiagLogLevel.ALL)

const tracer = require(${JSON.stringify(DD_TRACE_PATH)}).init({ startupLogs: false })
const provider = new tracer.TracerProvider()
provider.register()

const globalApi = globalThis[Symbol.for('opentelemetry.js.api.1')]
if (globalApi?.version !== ${JSON.stringify(API_OWNER_VERSION)}) {
  throw new Error('The compatibility owner did not adopt the diagnostic-only global')
}
if (api.trace.getTracerProvider().getDelegate?.() !== provider) {
  throw new Error('API 1.0.0 did not receive the tracer provider')
}
if (!holder.getApiOwner().metrics.getMeterProvider().reader) {
  throw new Error('The compatibility owner did not retain the meter provider')
}

const span = api.trace.getTracer('preloaded-copy-test').startSpan('preloaded-copy-test')
const traceId = span.spanContext().traceId
span.end()
if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
  throw new Error('OpenTelemetry bridge returned an invalid trace ID: ' + traceId)
}

console.log('OTEL_PRELOADED_GLOBAL_OK')
`
}

/**
 * @param {string} entry
 * @returns {string}
 */
function findPackageDirectory (entry) {
  let directory = path.dirname(entry)
  const { root } = path.parse(directory)
  while (directory !== root) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory
    directory = path.dirname(directory)
  }
  throw new Error(`Unable to find package.json for ${entry}`)
}
