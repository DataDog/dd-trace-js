'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const DSMTextMapPropagator = require('../../../src/opentracing/propagation/text_map_dsm')

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
})
