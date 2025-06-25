'use strict'

const t = require('tap')
require('../../setup/core')

const { expect } = require('chai')

t.test('TraceState', t => {
  let TraceState

  t.beforeEach(() => {
    TraceState = require('../../../src/opentracing/propagation/tracestate')
  })

  t.test('should convert from header', t => {
    const ts = TraceState.fromString('other=bleh,dd=s:2;o:foo;t.dm:-4')
    expect(ts).to.be.an.instanceOf(Map)
    expect(ts.get('other')).to.equal('bleh')
    expect(ts.get('dd')).to.equal('s:2;o:foo;t.dm:-4')
    t.end()
  })

  t.test('should convert to header', t => {
    // NOTE: order is reversed because it makes use of insertion order to represent last-edited
    // by deleting on-change so the most recently edited pairs will always appear at the end.
    // However the spec requires that entries are ordered recently edited first.
    const ts = new TraceState([
      ['dd', 's:2;o:foo;t.dm:-4'],
      ['other', 'bleh']
    ])
    expect(ts.toString()).to.equal('other=bleh,dd=s:2;o:foo;t.dm:-4')
    t.end()
  })

  t.test('should extract our vendor key as a map', t => {
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
    t.end()
  })

  t.test('should mutate value in tracestate when changing value', t => {
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
    t.end()
  })

  t.test('should mutate value in tracestate when deleting value', t => {
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
    t.end()
  })

  t.test('should remove value from tracestate when clearing values', t => {
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
    t.end()
  })
  t.end()
})
