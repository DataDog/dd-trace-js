'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const sinon = require('sinon')

require('../setup/core')
const format = require('../../src/span_format')
const { matrix, decodeMatrix } = require('./streaming-fixtures')

// The v0.5 wire emits every string as a uint32 index into a per-payload table,
// and the streaming path caches strings in walk order while the object path
// caches the head fields first — so the two payloads carry the same strings at
// different indices. Byte-equality is therefore unreachable by construction;
// the gate resolves both payloads back through their own string tables and
// compares the decoded spans, which is the contract the agent actually decodes.
function entriesOf (map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map)
}

/**
 * @param {string[]} stringTable
 * @param {Record<string, number> | Map<number, number>} map
 * @param {boolean} valuesAreIndices Metrics values are raw numbers, not indices.
 */
function resolveMap (stringTable, map, valuesAreIndices) {
  const resolved = {}
  for (const [key, value] of entriesOf(map)) {
    resolved[stringTable[Number(key)]] = valuesAreIndices ? stringTable[value] : value
  }
  return resolved
}

/**
 * @param {Buffer} payload A v0.5 `[stringTable, traces]` msgpack payload.
 */
function resolvePayload (payload) {
  const [stringTable, traces] = msgpack.decode(payload, { useBigInt64: true })
  return traces.map((trace) => trace.map((span) => {
    const [service, name, resource, traceId, spanId, parentId, start, duration, error, meta, metrics, type] = span
    return {
      service: stringTable[service],
      name: stringTable[name],
      resource: stringTable[resource],
      type: stringTable[type],
      traceId,
      spanId,
      parentId,
      start,
      duration,
      error,
      meta: resolveMap(stringTable, meta, true),
      metrics: resolveMap(stringTable, metrics, false),
    }
  }))
}

function buildEncoders () {
  const { AgentEncoder } = require('../../src/encode/0.5')
  return {
    objectEncoder: new AgentEncoder({ flush: sinon.spy() }),
    streamingEncoder: new AgentEncoder({ flush: sinon.spy() }),
  }
}

describe('encode 0.5 streaming decode-equality', () => {
  for (const [label, build] of Object.entries({ ...matrix, ...decodeMatrix })) {
    it(`decodes identically to the object path for ${label}`, () => {
      const { objectEncoder, streamingEncoder } = buildEncoders()

      objectEncoder.encode([format(build(), true, false)])
      const objectSpans = resolvePayload(objectEncoder.makePayload())

      streamingEncoder.encodeRaw([build()], false)
      const streamingSpans = resolvePayload(streamingEncoder.makePayload())

      assert.deepStrictEqual(streamingSpans, objectSpans)
    })
  }

  it('flushes when the trace buffer passes the soft limit', () => {
    const { AgentEncoder } = require('../../src/encode/0.5')
    const flush = sinon.spy()
    const encoder = new AgentEncoder({ flush }, 256)

    encoder.encodeRaw([matrix['http server root span']()], false)

    assert.ok(flush.called)
  })
})
