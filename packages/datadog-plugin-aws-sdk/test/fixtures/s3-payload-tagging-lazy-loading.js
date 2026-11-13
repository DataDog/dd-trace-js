'use strict'

const { writeFileSync } = require('node:fs')
const Module = require('node:module')

const {
  S3_LAZY_SDK: sdk,
  S3_LAZY_VERSION: version,
  S3_LAZY_CAPTURE: capture,
  S3_LAZY_INTERCEPT: intercept,
  S3_LAZY_ENDPOINT: endpoint,
  S3_LAZY_OUT: out,
  DD_TRACE_AGENT_PORT: port,
} = process.env
if (sdk !== 'v2' && sdk !== 'v3') {
  throw new Error(`fixture requires S3_LAZY_SDK to be 'v2' or 'v3', got ${sdk}`)
}
if (!version) {
  throw new Error('fixture requires S3_LAZY_VERSION to name the selected workspace version')
}
if (capture !== 'disabled' && capture !== 'request' && capture !== 'response' && capture !== 'both') {
  throw new Error(`fixture requires S3_LAZY_CAPTURE to be 'disabled', 'request', 'response' or 'both', got ${capture}`)
}
if (intercept !== 'none' && intercept !== 'fail-first') {
  throw new Error(`fixture requires S3_LAZY_INTERCEPT to be 'none' or 'fail-first', got ${intercept}`)
}
if (!out) {
  throw new Error('fixture requires S3_LAZY_OUT to name the result file to write')
}

// Resolve without executing so the cache checks below observe real loading.
const tagIndexPath = require.resolve('../../../dd-trace/src/payload-tagging')
const snapshotPath = require.resolve('../../../dd-trace/src/payload-tagging/snapshot')
const baseJsPath = require.resolve('../../../datadog-plugin-aws-sdk/src/base')

function modulesLoaded () {
  return (tagIndexPath in require.cache) || (snapshotPath in require.cache)
}

const cloudPayloadTagging = {
  disabled: {},
  request: { request: 'all', maxDepth: 10 },
  response: { response: 'all', maxDepth: 10 },
  both: { request: 'all', response: 'all', maxDepth: 10 },
}[capture]

// Count imports of the payload-tagging module from the AWS base plugin and,
// in fail-first mode, make the first one throw. The eager preload runs during
// tracer init, so the interception must be installed before init. Delegating
// unrelated imports keeps the rest of the process behavior intact.
const failFirst = intercept === 'fail-first'
let importAttempts = 0
let importFailures = 0
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent?.filename === baseJsPath && request === '../../dd-trace/src/payload-tagging') {
    importAttempts++
    if (failFirst && importFailures === 0) {
      importFailures++
      throw new Error('simulated payload-tagging load failure')
    }
  }
  return originalLoad(request, parent, isMain)
}

const tracer = require('../../../dd-trace').init({
  service: 's3-lazy-loading',
  hostname: '127.0.0.1',
  port: Number(port),
  flushInterval: 10,
  startupLogs: false,
  telemetry: { enabled: false },
  remoteConfig: { enabled: false },
  cloudPayloadTagging,
})
// Keep the fixture focused on the AWS span, rather than its HTTP children.
tracer.use('http', false)

const loadedAfterTracerInit = modulesLoaded()

require('../../../datadog-plugin-aws-sdk/src')
const loadedAfterPluginRequire = modulesLoaded()

// Load the selected workspace folder rather than a hardcoded version so the
// fixture only requires the SDK family the suite selected (RANGE-filtered).
const AWS = require(`../../../../versions/${sdk === 'v3' ? '@aws-sdk/client-s3' : 'aws-sdk'}@${version}`).get()
const s3 = new AWS.S3({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  s3ForcePathStyle: true,
  forcePathStyle: true,
  maxRetries: 0,
  maxAttempts: 1,
  computeChecksums: false,
  requestChecksumCalculation: 'WHEN_REQUIRED',
})

const loadedAfterClientCreation = modulesLoaded()

function putObject (params) {
  return new Promise((resolve, reject) => {
    s3.putObject(params, (error, data) => error ? reject(error) : resolve(data))
  })
}

async function main () {
  await putObject({ Bucket: 's3-lazy-loading', Key: 'first', Body: Buffer.from('original bytes') })
  const loadedAfterFirstOperation = modulesLoaded()
  await putObject({ Bucket: 's3-lazy-loading', Key: 'next', Body: Buffer.from('original bytes') })

  writeFileSync(out, JSON.stringify({
    loadedAfterTracerInit,
    loadedAfterPluginRequire,
    loadedAfterClientCreation,
    loadedAfterFirstOperation,
    loadedAfterOperations: modulesLoaded(),
    importAttempts,
    importSuccesses: importAttempts - importFailures,
  }))
  s3.destroy?.()
}

main().catch(error => {
  // Surface the failure without a console statement, which the lint rules
  // reject in this package.
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  process.exitCode = 1
})
