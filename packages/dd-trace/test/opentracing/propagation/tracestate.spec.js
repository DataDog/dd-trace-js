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
    assert.strictEqual(ts.get('other'), 'bleh')
    assert.strictEqual(ts.get('dd'), 's:2;o:foo;t.dm:-4')
    assert.strictEqual(ts.size, 2)
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

      assert.strictEqual(state.get('s'), '2')
      assert.strictEqual(state.get('o'), 'foo:bar')
      assert.strictEqual(state.get('t.dm'), '-4')
      assert.strictEqual(state.size, 3)
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

  it('should cap parsing at 32 list-members per W3C Trace Context §3.3.1.2', () => {
    const header = Array.from({ length: 33 }, (_, index) => `k${index}=v${index}`).join(',')
    const ts = TraceState.fromString(header)
    assert.strictEqual(ts.size, 32)
  })

  it('should accept internal spaces but drop tabs in tracestate values per W3C Trace Context §3.3.1.3.2', () => {
    const ts = TraceState.fromString('a=hello world,b=bye\tworld,c=ok')
    assert.strictEqual(ts.toString(), 'a=hello world,c=ok')
  })

  it('should preserve leading 0x20 but strip trailing whitespace per W3C Trace Context §3.3.1.3.2', () => {
    // value = 0*255(chr) nblk-chr; chr includes 0x20, so the first character can be a space.
    // Trailing whitespace is OWS around the comma (or header end), not part of the value.
    const ts = TraceState.fromString('a= leading,b=trailing ,c=ok')
    assert.strictEqual(ts.toString(), 'a= leading,b=trailing,c=ok')
  })

  it('should ignore non-conformant input that contains no list-members', () => {
    const ts = TraceState.fromString('a'.repeat(16_000))
    assert.strictEqual(ts.size, 0)
  })
})
