'use strict'

const assert = require('node:assert/strict')

const {
  S3_PAYLOAD_SDK: sdk,
  S3_PAYLOAD_SCENARIO: scenario,
  S3_PAYLOAD_CAPTURE: capture,
  S3_PAYLOAD_ENDPOINT: endpoint,
  DD_TRACE_AGENT_PORT: port,
} = process.env
const enabled = capture === 'enabled'
const tracer = require('../../../dd-trace').init({
  service: 's3-fail-soft',
  hostname: '127.0.0.1',
  port: Number(port),
  flushInterval: 10,
  startupLogs: false,
  telemetry: { enabled: false },
  remoteConfig: { enabled: false },
  cloudPayloadTagging: enabled ? { request: 'all', response: 'all', maxDepth: 10 } : {},
})
// Keep the fixture focused on the AWS span, rather than its HTTP children.
tracer.use('http', false)
const AWS = sdk === 'v3'
  ? require('../../../../versions/@aws-sdk/client-s3@3').get()
  : require('../../../../versions/aws-sdk@2').get()
/**
 * @typedef {{
 *   putObject: (params: object, callback: (error: Error | null, data: object) => void) => void,
 *   destroy?: () => void
 * }} S3FixtureClient
 */
const s3 = /** @type {S3FixtureClient} */ (/** @type {unknown} */ (new AWS.S3({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  s3ForcePathStyle: true,
  forcePathStyle: true,
  maxRetries: 0,
  maxAttempts: 1,
  computeChecksums: false,
  requestChecksumCalculation: 'WHEN_REQUIRED',
})))
const plugin = tracer._pluginManager._pluginsByName['aws-sdk'].services.s3
let inspections = 0
let failures = 0
const error = new Error('payload-secret')
Object.defineProperty(error, 'name', {
  get () {
    inspections++
    throw error
  },
})

function fail () {
  failures++
  throw error
}

async function main () {
  const params = { Bucket: 's3-fail-soft', Key: 'first', Body: Buffer.from('original bytes') }
  let restore = () => {}
  if (scenario === 'snapshot') {
    Object.defineProperty(params, 'getReader', { get: fail })
  } else {
    const property = scenario === 'request' ? 'payloadTaggingRules' : 'extractResponseBody'
    const original = Object.getOwnPropertyDescriptor(plugin, property)
    const rules = plugin.payloadTaggingRules
    Object.defineProperty(plugin, property, scenario === 'request'
      ? { configurable: true, get () { if (failures === 0) fail(); return rules } }
      : { configurable: true, value: fail })
    restore = () => {
      if (original) Object.defineProperty(plugin, property, original)
      else delete plugin[property]
    }
  }
  try {
    await new Promise((resolve, reject) => {
      s3.putObject(params, (error, data) => error ? reject(error) : resolve(data))
    })
  } finally {
    restore()
  }
  await new Promise((resolve, reject) => {
    s3.putObject({ ...params, Key: 'next' }, (error, data) => error ? reject(error) : resolve(data))
  })
  assert.strictEqual(inspections, 0)
  assert.strictEqual(failures, enabled ? 1 : 0)
  s3.destroy?.()
}

main()
