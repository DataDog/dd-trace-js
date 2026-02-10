'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../../setup/core')

describe('TraceState', () => {
  let TraceState

  beforeEach(() => {
    TraceState = require('../../../src/opentracing/propagation/tracestate')
  })

  it('should convert from header', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo;t.dm:-4')
    assert.ok(ts instanceof Map)
    assert.strictEqual(ts.get('other'), 'bleh')
    assert.strictEqual(ts.get('dd'), 's:2;o:foo;t.dm:-4')
  })

  it('should convert to header', () => {
    // NOTE: order is reversed because it makes use of insertion order to represent last-edited
    // by deleting on-change so the most recently edited pairs will always appear at the end.
    // However the spec requires that entries are ordered recently edited first.
    const ts = new TraceState([
      ['dd', 's:2;o:foo;t.dm:-4'],
      ['other', 'bleh'],
    ])
    assert.strictEqual(ts.toString(), 'other=bleh,dd=s:2;o:foo;t.dm:-4')
  })

  it('should extract our vendor key as a map', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    let called = false
    ts.forVendor('dd', (state) => {
      called = true

      assert.ok(state instanceof Map)
      assert.strictEqual(state.get('s'), '2')
      assert.strictEqual(state.get('o'), 'foo:bar')
      assert.strictEqual(state.get('t.dm'), '-4')
    })
    assert.strictEqual(called, true)
  })

  it('should mutate value in tracestate when changing value', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    // Set
    ts.forVendor('dd', (state) => {
      assert.strictEqual(state.changed, false)
      state.set('o', 'baz:buz')
      assert.strictEqual(state.changed, true)
    })
    assert.strictEqual(ts.get('dd'), 's:2;o:baz:buz;t.dm:-4')

    // Vendor key should move to the front on modification
    assert.strictEqual(ts.toString(), 'dd=s:2;o:baz:buz;t.dm:-4,other=bleh')
  })

  it('should mutate value in tracestate when deleting value', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    // Delete
    ts.forVendor('dd', (state) => {
      assert.strictEqual(state.changed, false)
      state.delete('o')
      assert.strictEqual(state.changed, true)
    })
    assert.strictEqual(ts.get('dd'), 's:2;t.dm:-4')

    // Vendor key should move to the front on modification
    assert.strictEqual(ts.toString(), 'dd=s:2;t.dm:-4,other=bleh')
  })

  it('should remove value from tracestate when clearing values', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    // Clear
    ts.forVendor('dd', (state) => {
      assert.strictEqual(state.changed, false)
      state.clear()
      assert.strictEqual(state.changed, true)
    })
    assert.strictEqual(ts.get('dd'), undefined)

    // Vendor key should move to the front on modification
    assert.strictEqual(ts.toString(), 'other=bleh')
  })
})
