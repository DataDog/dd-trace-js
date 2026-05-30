'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { makeSpan, matrix, decodeMatrix } = require('./streaming-fixtures')

function loadEncoder ({ debug = false, nativeSpanEvents = false } = {}) {
  const logger = { debug: sinon.stub() }
  const getConfig = () => ({
    DD_TRACE_NATIVE_SPAN_EVENTS: nativeSpanEvents,
    DD_TRACE_ENCODING_DEBUG: debug,
  })
  const { AgentEncoder } = proxyquire('../../src/encode/0.4', {
    '../log': logger,
    '../config': getConfig,
  })
  return { AgentEncoder, logger }
}

function buildEncoders (nativeSpanEvents) {
  const { AgentEncoder } = loadEncoder({ nativeSpanEvents })
  const objectEncoder = new AgentEncoder({ flush: sinon.spy() })
  const streamingEncoder = new AgentEncoder({ flush: sinon.spy() })
  return { objectEncoder, streamingEncoder }
}

describe('encode 0.4 streaming byte-equality', () => {
  let format

  beforeEach(() => {
    format = require('../../src/span_format')
  })

  for (const nativeSpanEvents of [false, true]) {
    describe(`DD_TRACE_NATIVE_SPAN_EVENTS=${nativeSpanEvents}`, () => {
      for (const [label, build] of Object.entries(matrix)) {
        it(`produces byte-identical 0.4 output for ${label}`, () => {
          const { objectEncoder, streamingEncoder } = buildEncoders(nativeSpanEvents)

          const objectSpan = build()
          objectEncoder.encode([format(objectSpan, true, false)])
          const objectBytes = objectEncoder.makePayload()

          const streamingSpan = build()
          streamingEncoder.encodeRaw([streamingSpan], false)
          const streamingBytes = streamingEncoder.makePayload()

          assert.deepStrictEqual(streamingBytes, objectBytes)
        })
      }

      for (const [label, build] of Object.entries(decodeMatrix)) {
        it(`produces decode-identical 0.4 output for ${label}`, () => {
          const { objectEncoder, streamingEncoder } = buildEncoders(nativeSpanEvents)

          objectEncoder.encode([format(build(), true, false)])
          const objectDecoded = msgpack.decode(objectEncoder.makePayload(), { useBigInt64: true })

          streamingEncoder.encodeRaw([build()], false)
          const streamingDecoded = msgpack.decode(streamingEncoder.makePayload(), { useBigInt64: true })

          assert.deepStrictEqual(streamingDecoded, objectDecoded)
        })
      }
    })
  }

  it('flushes when the trace buffer passes the soft limit', () => {
    const { AgentEncoder } = loadEncoder()
    const flush = sinon.spy()
    const encoder = new AgentEncoder({ flush }, 256)

    encoder.encodeRaw([matrix['http server root span']()], false)

    assert.ok(flush.called)
  })

  it('logs the encoded buffer when encoding debug is on', () => {
    const { AgentEncoder, logger } = loadEncoder({ debug: true })
    const encoder = new AgentEncoder({ flush: sinon.spy() })

    encoder.encodeRaw([makeSpan()], false)

    assert.ok(logger.debug.called)
  })
})
