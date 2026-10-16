'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const { inspect } = require('./assertions.cjs')
const { select } = require('./matrix.cjs')
const metadata = require('./metadata.json')
const mode = process.env.COMPAT_MODE || 'normal'
const filter = process.env.COMPAT_FILTER
const rows = []
require('./verify.cjs')
const cases = select(mode, filter)
assert.ok(cases.length, 'Filter selected zero cases')

for (const { entry, scenario } of cases) {
  const env = {
    PATH: process.env.PATH,
    COMPAT_ENTRY: entry,
    COMPAT_CASE: scenario,
    LAMBDA_TASK_ROOT: '/var/task',
    AWS_LAMBDA_FUNCTION_NAME: 'legacy-lambda-compat',
    AWS_REGION: 'us-east-1',
    DD_TRACE_ENABLED: String(scenario !== 'metrics-only'),
    DD_FLUSH_TO_LOG: 'true',
    DD_TRACE_STARTUP_LOGS: 'false',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    DD_REMOTE_CONFIGURATION_ENABLED: 'false',
    DD_COLD_START_TRACING: 'false',
    DD_APM_FLUSH_DEADLINE_MILLISECONDS: '200',
    DD_RUNTIME_METRICS_ENABLED: 'false',
  }
  if (mode === 'layer-only') env.NODE_PATH = '/opt/nodejs/node_modules'
  if (mode === 'preload') env.NODE_OPTIONS = '--require dd-trace/init'
  if (entry !== 'npm') env.DD_LAMBDA_HANDLER = entry.endsWith('esm') ? 'handler-esm.handler' : 'handler-cjs.handler'
  if (scenario === 'custom-config' && entry !== 'npm') {
    env.DD_TRACE_EXTRACTOR = 'extractor.extract'
    env.DD_CAPTURE_LAMBDA_PAYLOAD = 'true'
  }
  if (scenario === 'disabled-instrumentation') env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'lambda'
  if (scenario === 'timeout-plugin-disabled') env.DD_TRACE_DISABLED_PLUGINS = 'aws-lambda'
  const child = spawnSync(process.execPath, ['/var/task/invoke.cjs'], { env, encoding: 'utf8', timeout: 15000 })
  const records = (child.stdout || '').split('\n').flatMap(line => {
    try { return [JSON.parse(line.replace(/^\[dd\.trace_id=[^\]]+\]\s*/, ''))] } catch { return [] }
  })
  // Assertion code errors abort the suite; they are never eligible for an expected-failure exception.
  const failures = inspect(child, records, scenario, metadata)
  const row = {
    entry,
    scenario,
    passed: failures.length === 0,
    failures,
    signature: JSON.stringify(failures),
    stdout: child.stdout,
    stderr: child.stderr,
  }
  rows.push(row)
  console.log(`${row.passed ? 'PASS' : 'FAIL'} ${entry}/${scenario}: ${row.signature}`)
}

const report = {
  runtime: process.version,
  architecture: process.arch,
  mode,
  tracerVersion: metadata.version,
  shimVersion: metadata.shimVersion,
  shimSha256: metadata.shimSha256,
  fixtureSha256: metadata.fixtureSha256,
  rows,
}
const output = `/var/task/results-node${process.versions.node.split('.')[0]}-${mode}.json`
writeFileSync(output, JSON.stringify(report, null, 2))
console.log(`${rows.filter(row => row.passed).length}/${rows.length} compatibility cases passed on ${process.version}`)
process.exitCode = rows.some(row => !row.passed) ? 1 : 0
