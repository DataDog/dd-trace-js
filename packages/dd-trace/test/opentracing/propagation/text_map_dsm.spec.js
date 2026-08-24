'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const DSMTextMapPropagator = require('../../../src/opentracing/propagation/text_map_dsm')
const log = require('../../../src/log')

const context = {
  hash: Buffer.alloc(8),
  pathwayStartNs: 0,
  edgeStartNs: 0,
}

describe('DSMTextMapPropagator', () => {
  it('lazily creates and returns a carrier', () => {
    const carrier = new DSMTextMapPropagator({ dsmEnabled: true }).inject(context)

    assert.ok(carrier)
    assert.strictEqual(typeof carrier['dd-pathway-ctx-base64'], 'string')
  })

  it('returns the provided carrier', () => {
    const carrier = /** @type {Record<string, string>} */ ({})
    const propagator = new DSMTextMapPropagator({ dsmEnabled: true })

    assert.strictEqual(propagator.inject(context, carrier), carrier)
  })

  it('returns undefined when DSM is disabled', () => {
    const propagator = new DSMTextMapPropagator({ dsmEnabled: false })

    assert.strictEqual(propagator.inject(context), undefined)
  })

  it('returns undefined when no pathway context is available', () => {
    const propagator = new DSMTextMapPropagator({ dsmEnabled: true })

    assert.strictEqual(propagator.inject(undefined), undefined)
  })

  it('extracts a pathway context and evaluates managed-field debug projections', () => {
    const debug = sinon.stub(log, 'debug').callsFake(callback => callback())
    const propagator = new DSMTextMapPropagator({ dsmEnabled: true })

    try {
      const carrier = propagator.inject(context)
      const extracted = propagator.extract(carrier)

      assert.deepStrictEqual(extracted.hash, context.hash)
      assert.strictEqual(debug.callCount, 4)
    } finally {
      debug.restore()
    }
  })
})
