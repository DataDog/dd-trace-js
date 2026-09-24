'use strict'

const assert = require('node:assert/strict')
const { URL } = require('node:url')

const guard = require('../startup-guard')

const crossPayloadEncoderPath = '../../../packages/dd-trace/src/encode/0.4-cross-payload'
const commonRequestPath = require.resolve('../../../packages/dd-trace/src/exporters/common/request')
const OPERATIONS = Number(process.env.OPERATIONS) || 300_000
const TRACE_SPANS = Number(process.env.TRACE_SPANS) || 10
const WARMUP_PAYLOADS = 5_000

let lastPayload
let lastTraceCount
let payloadCount = 0
let createCrossPayloadAgentEncoder
let crossPayloadEncoderAvailable = false
let crossPayloadEncoderCreated = false
let crossPayloadEncoderDisabled = false

/**
 * @param {Buffer} payload
 * @param {{ headers: Record<string, string> }} options
 */
function captureRequest (payload, options) {
  lastPayload = payload
  lastTraceCount = Number(options.headers['X-Datadog-Trace-Count'])
  payloadCount++
}

/**
 * @param {{ flush: () => void }} writer
 * @param {() => void} disableCrossPayloadCache
 * @returns {import('../../../packages/dd-trace/src/encode/0.4').AgentEncoder}
 */
function createTrackedAgentEncoder (writer, disableCrossPayloadCache) {
  crossPayloadEncoderCreated = true
  const disableTrackedCrossPayloadCache = () => {
    crossPayloadEncoderDisabled = true
    disableCrossPayloadCache()
  }
  return createCrossPayloadAgentEncoder(writer, disableTrackedCrossPayloadCache)
}

Object.defineProperty(captureRequest, 'writable', { value: true })

// Install the no-op egress before AgentWriter captures the request function.
require.cache[commonRequestPath] = {
  id: commonRequestPath,
  filename: commonRequestPath,
  loaded: true,
  exports: captureRequest,
}

const AgentWriter = require('../../../packages/dd-trace/src/exporters/agent/writer')
const { buildTrace, tickTrace } = require('./trace-fixture')

let resolvedCrossPayloadEncoderPath
try {
  resolvedCrossPayloadEncoderPath = require.resolve(crossPayloadEncoderPath)
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}
if (resolvedCrossPayloadEncoderPath !== undefined) {
  const crossPayloadEncoder = require(resolvedCrossPayloadEncoderPath)
  createCrossPayloadAgentEncoder = crossPayloadEncoder.createAgentEncoder
  crossPayloadEncoder.createAgentEncoder = createTrackedAgentEncoder
  crossPayloadEncoderAvailable = true
}

const trace = buildTrace(TRACE_SPANS)
const writer = new AgentWriter({
  url: new URL('http://127.0.0.1:8126'),
  prioritySampler: { update: () => {} },
  protocolVersion: '0.4',
  flushInterval: 0,
  headers: {},
})

for (let iteration = 0; iteration < WARMUP_PAYLOADS; iteration++) {
  tickTrace(trace, iteration)
  writer.append(trace)
  writer.flush()
}

assert.equal(payloadCount, WARMUP_PAYLOADS)
assert.equal(lastTraceCount, 1)
assert.ok(lastPayload.length > 0)
assert.equal(crossPayloadEncoderCreated, crossPayloadEncoderAvailable, 'flushInterval 0 selected the wrong encoder')
assert.equal(crossPayloadEncoderDisabled, false, 'cross-payload cache disabled during warmup')

payloadCount = 0
guard.loopStart()
for (let iteration = 0; iteration < OPERATIONS; iteration++) {
  tickTrace(trace, iteration)
  writer.append(trace)
  writer.flush()
}
guard.done(0.15)
assert.equal(payloadCount, OPERATIONS)
assert.equal(crossPayloadEncoderDisabled, false, 'cross-payload cache disabled during the measured loop')
