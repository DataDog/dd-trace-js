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

  it('should parse more than 32 fields within a vendor member', () => {
    const fields = Array.from({ length: 40 }, (_, index) => `k${index}:v`).join(';')
    const ts = TraceState.fromString(`ot=${fields}`)

    ts.forVendor('ot', state => {
      assert.strictEqual(state.size, 40)
      assert.strictEqual(state.get('k39'), 'v')
    })
  })

  it('should accept 256-character member values and reject 257-character member values', () => {
    const accepted = 'x'.repeat(256)
    const ts = TraceState.fromString(`a=${accepted},b=${'x'.repeat(257)},c=ok`)

    assert.strictEqual(ts.get('a'), accepted)
    assert.strictEqual(ts.get('b'), undefined)
    assert.strictEqual(ts.get('c'), 'ok')
  })

  it('should accept 256-character updates and reject 257-character updates', () => {
    const accepted = 'x'.repeat(256)
    const ts = TraceState.fromString('a=original')

    ts.set('a', accepted)
    ts.set('a', 'x'.repeat(257))

    assert.strictEqual(ts.get('a'), accepted)
  })

  it('should remove a vendor member when required fields exceed the value limit', () => {
    const ts = TraceState.fromString('dd=required:original')

    ts.forVendor('dd', state => state.set('required', 'x'.repeat(250)), () => false)

    assert.strictEqual(ts.get('dd'), undefined)
  })

  it('should not inspect optional fields when an update fits the value limit', () => {
    const ts = TraceState.fromString('dd=required:original')
    let calls = 0

    ts.forVendor('dd', state => state.set('required', 'updated'), () => {
      calls++
      return true
    })

    assert.strictEqual(calls, 0)
    assert.strictEqual(ts.get('dd'), 'required:updated')
  })

  it('should remove a vendor member when its only field is optional and exceeds the value limit', () => {
    const ts = TraceState.fromString('dd=optional:original')

    ts.forVendor('dd', state => state.set('optional', 'x'.repeat(250)), () => true)

    assert.strictEqual(ts.get('dd'), undefined)
  })

  for (const valueLength of [226, 227]) {
    it(`should prune optional fields once in reverse order at ${valueLength + 30} characters`, () => {
      const ts = new TraceState()
      const inspected = new Set()
      const value = 'x'.repeat(valueLength)

      ts.forVendor('dd', state => {
        state.set('t.keep', value)
        state.set('s', '1')
        state.set('t.drop1', 'x'.repeat(20))
        state.set('p', '0123456789abcdef')
        state.set('t.drop2', 'x'.repeat(20))
      }, key => {
        assert.strictEqual(inspected.has(key), false)
        inspected.add(key)
        return key.startsWith('t.')
      })

      assert.strictEqual(ts.get('dd'), 'p:0123456789abcdef;s:1' + (valueLength === 226 ? `;t.keep:${value}` : ''))
    })
  }

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

  it('should not rewrite a vendor after deleting a missing value', () => {
    const ts = TraceState.fromString('other=bleh,dd=s:2')

    ts.forVendor('dd', state => state.delete('missing'))

    assert.strictEqual(ts.toString(), 'other=bleh,dd=s:2')
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

  it('should clone without sharing mutations', () => {
    const original = TraceState.fromString('other=bleh,dd=s:2')
    const clone = original.clone()

    clone.delete('other')
    clone.set('dd', 's:1')

    assert.strictEqual(original.toString(), 'other=bleh,dd=s:2')
    assert.strictEqual(clone.toString(), 'dd=s:1')
  })

  it('should cap parsing at 32 list-members per W3C Trace Context §3.3.1.2', () => {
    const header = Array.from({ length: 33 }, (_, index) => `k${index}=v${index}`).join(',')
    const ts = TraceState.fromString(header)
    assert.strictEqual(ts.size, 32)
  })

  it('should cap constructor entries at 32 list-members', () => {
    const entries = Array.from({ length: 33 }, (_, index) => [`k${32 - index}`, `v${32 - index}`])
    const ts = new TraceState(entries)

    assert.strictEqual(ts.size, 32)
    assert.strictEqual(ts.get('k32'), undefined)
    assert.strictEqual(ts.toString().split(',').at(-1), 'k31=v31')
  })

  it('should keep the 32 leftmost list-members after updates', () => {
    const header = Array.from({ length: 32 }, (_, index) => `k${index}=v${index}`).join(',')
    const ts = TraceState.fromString(header)
    ts.set('ot', 'rv:f0948a54d43b8e;th:8')
    ts.set('dd', 's:1')

    const members = ts.toString().split(',')
    assert.strictEqual(ts.size, 32)
    assert.strictEqual(members.length, 32)
    assert.deepStrictEqual(members.slice(0, 3), ['dd=s:1', 'ot=rv:f0948a54d43b8e;th:8', 'k0=v0'])
    assert.strictEqual(members[31], 'k29=v29')

    ts.delete('dd')
    const remainingMembers = ts.toString().split(',')
    assert.strictEqual(remainingMembers.length, 31)
    assert.strictEqual(remainingMembers[30], 'k29=v29')
  })

  it('should not impose an aggregate length limit', () => {
    const value = 'x'.repeat(170)
    const ts = TraceState.fromString(`a=${value},b=${value},c=${value}`)

    assert.strictEqual(ts.toString().length, 518)
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
