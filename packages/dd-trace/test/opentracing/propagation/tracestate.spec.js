'use strict'

const { expect } = require('chai')

describe('TraceState', () => {
  let TraceState

  beforeEach(() => {
    TraceState = require('../../../src/opentracing/propagation/tracestate')
  })

  it('should convert from header', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo;t.dm:-4')
    expect(ts).to.be.an.instanceOf(Map)
    expect(ts.get('other')).to.equal('bleh')
    expect(ts.get('dd')).to.equal('s:2;o:foo;t.dm:-4')
  })

  it('should convert to header', () => {
    // NOTE: order is reversed because it makes use of insertion order to represent last-edited
    // by deleting on-change so the most recently edited pairs will always appear at the end.
    // However the spec requires that entries are ordered recently edited first.
    const ts = new TraceState([
      ['dd', 's:2;o:foo;t.dm:-4'],
      ['other', 'bleh']
    ])
    expect(ts.toString()).to.equal('other=bleh,dd=s:2;o:foo;t.dm:-4')
  })

  it('should extract our vendor key as a map', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    let called = false
    ts.forVendor('dd', (state) => {
      called = true

      expect(state).to.be.an.instanceOf(Map)
      expect(state.get('s')).to.equal('2')
      expect(state.get('o')).to.equal('foo:bar')
      expect(state.get('t.dm')).to.equal('-4')
    })
    expect(called).to.be.true
  })

  it('should mutate value in tracestate when changing value', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    // Set
    ts.forVendor('dd', (state) => {
      expect(state.changed).to.be.false
      state.set('o', 'baz:buz')
      expect(state.changed).to.be.true
    })
    expect(ts.get('dd')).to.equal('s:2;o:baz:buz;t.dm:-4')

    // Vendor key should move to the front on modification
    expect(ts.toString()).to.equal('dd=s:2;o:baz:buz;t.dm:-4,other=bleh')
  })

  it('should mutate value in tracestate when deleting value', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    // Delete
    ts.forVendor('dd', (state) => {
      expect(state.changed).to.be.false
      state.delete('o')
      expect(state.changed).to.be.true
    })
    expect(ts.get('dd')).to.equal('s:2;t.dm:-4')

    // Vendor key should move to the front on modification
    expect(ts.toString()).to.equal('dd=s:2;t.dm:-4,other=bleh')
  })

  it('should remove value from tracestate when clearing values', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo:bar;t.dm:-4')

    // Clear
    ts.forVendor('dd', (state) => {
      expect(state.changed).to.be.false
      state.clear()
      expect(state.changed).to.be.true
    })
    expect(ts.get('dd')).to.be.undefined

    // Vendor key should move to the front on modification
    expect(ts.toString()).to.equal('other=bleh')
  })
})
