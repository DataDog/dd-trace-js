'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DD_TRACE_PATH = path.join(__dirname, '..', '..')
const OTEL_API_DIRECTORY = findPackageDirectory(require.resolve('@opentelemetry/api'))
const OTEL_API_LOGS_DIRECTORY = findPackageDirectory(require.resolve('@opentelemetry/api-logs'))

const EXTERNALS = [
  'diagnostics_channel',
  'pg',
  'mysql2',
  'better-sqlite3',
  'sqlite3',
  'mysql',
  'oracledb',
  'pg-query-stream',
  'tedious',
  '@yaacovcr/transform',
  '@datadog/native-appsec',
  '@datadog/native-iast-taint-tracking',
  '@datadog/native-metrics',
  '@datadog/pprof',
  '@datadog/libdatadog',
]

/**
 * @param {object} options
 * @param {boolean} options.applicationOwnsApi
 * @param {(paths: { entry: string, outfile: string, workingDirectory: string }) => Promise<void>} options.build
 * @param {string} options.extension
 */
async function runOtelApiBundleScenario ({ applicationOwnsApi, build, extension }) {
  const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-bundle-build-'))
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-bundle-runtime-'))
  const entry = path.join(buildDirectory, 'app.js')
  const outfile = path.join(buildDirectory, `out.${extension}`)

  try {
    fs.writeFileSync(path.join(buildDirectory, 'package.json'), JSON.stringify({
      name: 'otel-api-bundle-app',
      private: true,
      dependencies: applicationOwnsApi
        ? { '@opentelemetry/api': '*', '@opentelemetry/api-logs': '*' }
        : {},
    }))
    linkOtelApiPackages(buildDirectory)
    fs.writeFileSync(entry, applicationSource(applicationOwnsApi))

    await build({ entry, outfile, workingDirectory: buildDirectory })

    const relocated = path.join(runtimeDirectory, `out.${extension}`)
    fs.copyFileSync(outfile, relocated)
    fs.writeFileSync(path.join(runtimeDirectory, 'package.json'), JSON.stringify({
      name: 'relocated-otel-api-bundle',
      private: true,
      type: extension === 'mjs' ? 'module' : 'commonjs',
    }))
    if (applicationOwnsApi) linkOtelApiPackages(runtimeDirectory)

    let output
    try {
      const specifier = `./${path.basename(relocated)}`
      const preload = applicationOwnsApi
        ? "globalThis.__ddRuntimeApi = require('@opentelemetry/api'); " +
          "globalThis.__ddRuntimeApiLogs = require('@opentelemetry/api-logs'); "
        : ''
      const runner = `${preload}(async () => { try { await import(${JSON.stringify(specifier)}) } ` +
        'catch (error) { console.error(error.stack || error); process.exitCode = 1 } })()'
      output = execFileSync(process.execPath, ['-e', runner], {
        cwd: runtimeDirectory,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          DD_REMOTE_CONFIG_ENABLED: 'false',
          DD_TRACE_ENABLED: 'false',
          OTEL_LOGS_EXPORTER: '',
          OTEL_METRICS_EXPORTER: '',
          OTEL_TRACES_EXPORTER: '',
        },
      })
    } catch (error) {
      const stderr = String(error.stderr)
      const diagnostic = stderr
        .split('\n')
        .map(line => line.length < 1_000 ? line : `${line.slice(0, 100)}…${line.slice(-200)}`)
        .slice(-20)
        .join('\n')
      throw new Error(`${extension} applicationOwnsApi=${applicationOwnsApi}\n${diagnostic}`)
    }
    assert.match(output, /OTEL_API_BUNDLE_OK/)
  } finally {
    fs.rmSync(buildDirectory, { recursive: true, force: true })
    fs.rmSync(runtimeDirectory, { recursive: true, force: true })
  }
}

/**
 * @param {boolean} applicationOwnsApi
 * @returns {string}
 */
function applicationSource (applicationOwnsApi) {
  const applicationApi = applicationOwnsApi
    ? `const api = require('@opentelemetry/api')
const apiLogs = require('@opentelemetry/api-logs')`
    : `const api = holder.getApi()
const apiLogs = holder.getApiLogs()`
  const runtimeCopyAssertion = applicationOwnsApi
    ? `if (api.trace !== globalThis.__ddRuntimeApi.trace || apiLogs.logs !== globalThis.__ddRuntimeApiLogs.logs) {
  throw new Error('Application OpenTelemetry APIs were bundled instead of loaded at runtime')
}
if (api.trace !== holder.getApi().trace || apiLogs.logs !== holder.getApiLogs().logs) {
  throw new Error('The bridge did not capture the application OpenTelemetry APIs')
}
`
    : ''

  return `'use strict'
const holder = require(${JSON.stringify(path.join(DD_TRACE_PATH, 'packages/dd-trace/src/opentelemetry/api'))})
const tracer = require(${JSON.stringify(DD_TRACE_PATH)}).init({ startupLogs: false })
const provider = new tracer.TracerProvider()
provider.register()
${applicationApi}
${runtimeCopyAssertion}if (!apiLogs.SeverityNumber) {
  throw new Error('OpenTelemetry Logs API did not load')
}
const span = api.trace.getTracer('bundle-test').startSpan('bundle-test')
const traceId = span.spanContext().traceId
span.end()
if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
  throw new Error('OpenTelemetry bridge returned an invalid trace ID: ' + traceId)
}
console.log('OTEL_API_BUNDLE_OK')
process.exit(0)
`
}

/**
 * @param {string} directory
 */
function linkOtelApiPackages (directory) {
  const scopeDirectory = path.join(directory, 'node_modules', '@opentelemetry')
  fs.mkdirSync(scopeDirectory, { recursive: true })
  fs.symlinkSync(OTEL_API_DIRECTORY, path.join(scopeDirectory, 'api'), 'dir')
  fs.symlinkSync(OTEL_API_LOGS_DIRECTORY, path.join(scopeDirectory, 'api-logs'), 'dir')
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

module.exports = { EXTERNALS, runOtelApiBundleScenario }
