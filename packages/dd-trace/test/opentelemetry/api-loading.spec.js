'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, afterEach } = require('mocha')

const DD_TRACE_PATH = path.join(__dirname, '..', '..', '..', '..')
const API_DIRECTORY = findPackageDirectory(require.resolve('@opentelemetry/api'))
const API_LOGS_DIRECTORY = findPackageDirectory(require.resolve('@opentelemetry/api-logs'))
const INTERNAL_API_VERSION = '1.8.0'
const INTERNAL_API_LOGS_VERSION = '0.211.0'

describe('OpenTelemetry API copy loading', () => {
  const temporaryDirectories = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  for (const format of ['commonjs', 'module']) {
    it(`moves registered providers from an older copy to a custom ${format} API copy`, () => {
      const applicationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-api-loading-'))
      temporaryDirectories.push(applicationDirectory)
      fs.writeFileSync(path.join(applicationDirectory, 'package.json'), JSON.stringify({
        name: 'otel-api-loading-test',
        private: true,
      }))

      const customDirectory = path.join(applicationDirectory, 'custom')
      copyPackage(API_DIRECTORY, customDirectory, '@opentelemetry/api')
      copyPackage(API_LOGS_DIRECTORY, customDirectory, '@opentelemetry/api-logs')
      const loader = writeLoader(customDirectory, format)
      const internalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-api-internal-'))
      temporaryDirectories.push(internalDirectory)
      copyPackage(API_DIRECTORY, internalDirectory, '@opentelemetry/api', INTERNAL_API_VERSION)
      copyPackage(API_LOGS_DIRECTORY, internalDirectory, '@opentelemetry/api-logs', INTERNAL_API_LOGS_VERSION)
      const internalLoader = writeLoader(internalDirectory, 'commonjs')
      const entry = path.join(applicationDirectory, 'app.cjs')
      fs.writeFileSync(entry, applicationSource(loader, internalLoader, internalDirectory, format))

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
})

/**
 * @param {string} source
 * @param {string} customDirectory
 * @param {string} packageName
 * @param {string} [version]
 */
function copyPackage (source, customDirectory, packageName, version) {
  const destination = path.join(customDirectory, 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
  if (version) setPackageVersion(destination, version)
}

/**
 * @param {string} packageDirectory
 * @param {string} version
 */
function setPackageVersion (packageDirectory, version) {
  const manifestPath = path.join(packageDirectory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const originalVersion = manifest.version
  manifest.version = version
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  for (const format of ['src', 'esm', 'esnext']) {
    const versionPath = path.join(packageDirectory, 'build', format, 'version.js')
    if (!fs.existsSync(versionPath)) continue
    const source = fs.readFileSync(versionPath, 'utf8')
    fs.writeFileSync(versionPath, source.replaceAll(`'${originalVersion}'`, `'${version}'`))
  }
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
 * @param {string} internalLoader
 * @param {string} internalDirectory
 * @param {string} format
 * @returns {string}
 */
function applicationSource (applicationLoader, internalLoader, internalDirectory, format) {
  const load = format === 'module'
    ? `import(require('node:url').pathToFileURL(${JSON.stringify(applicationLoader)}))`
    : `require(${JSON.stringify(applicationLoader)})`
  const internalApiDirectory = path.join(internalDirectory, 'node_modules', '@opentelemetry', 'api')
  const internalApiLogsDirectory = path.join(internalDirectory, 'node_modules', '@opentelemetry', 'api-logs')

  return `'use strict'
const holder = require(${JSON.stringify(path.join(DD_TRACE_PATH, 'packages/dd-trace/src/opentelemetry/api'))})
const internal = require(${JSON.stringify(internalLoader)})
holder.setApi(internal.api, ${JSON.stringify(INTERNAL_API_VERSION)}, false, {
  moduleBaseDir: ${JSON.stringify(internalApiDirectory)}
})
holder.setApiLogs(internal.apiLogs, ${JSON.stringify(INTERNAL_API_LOGS_VERSION)}, false, {
  moduleBaseDir: ${JSON.stringify(internalApiLogsDirectory)}
})
const tracer = require(${JSON.stringify(DD_TRACE_PATH)}).init({ startupLogs: false })
const provider = new tracer.TracerProvider()
provider.register()

async function main () {
  const { api, apiLogs } = await ${load}
  if (api.trace.getTracerProvider().getDelegate?.() !== provider) {
    throw new Error('Trace provider stayed registered on the internal API copy')
  }
  const meterProvider = api.metrics.getMeterProvider()
  if (!meterProvider.reader) {
    throw new Error('Meter provider stayed registered on the internal API copy')
  }
  if (!apiLogs.logs.getLoggerProvider().processor) {
    throw new Error('Logger provider stayed registered on the internal API copy')
  }
  if (!apiLogs.logs._proxyLoggerProvider?._getDelegate?.().processor) {
    throw new Error('Application Logs API copy did not receive the logger provider')
  }

  const span = api.trace.getTracer('copy-test').startSpan('copy-test')
  const traceId = span.spanContext().traceId
  span.end()
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
    throw new Error('OpenTelemetry bridge returned an invalid trace ID: ' + traceId)
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
