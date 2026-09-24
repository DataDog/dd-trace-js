'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const {
  snapshotEvaluationContext,
  canonicalContextKey,
  validateContextSnapshot,
} = require('../../../src/openfeature/writers/flag-evaluation-context')

/** @param {object} context */
function attrs (context) {
  return { ...snapshotEvaluationContext(context).attrs }
}

describe('flag evaluation context snapshot', () => {
  it('revalidates a scalar snapshot without retaining behavior or malformed text', () => {
    const snapshot = { kept: 'value', number: 1, bool: false, nothing: null, malformed: '\uD800' }
    Object.defineProperty(snapshot, 'getter', {
      enumerable: true,
      get () {
        assert.fail('snapshot getter must not run')
        return undefined
      },
    })
    const result = validateContextSnapshot(snapshot)

    assert.deepStrictEqual({ ...result }, { kept: 'value', number: 1, bool: false, nothing: null })
    assert.strictEqual(Object.getPrototypeOf(result), null)
    assert.strictEqual(Object.isFrozen(result), true)
    assert.strictEqual(validateContextSnapshot(new Proxy({}, {
      ownKeys () { assert.fail('proxy must not be enumerated') },
    })), undefined)
  })

  it('flattens supported scalars, nested records, and lists without retaining caller objects', () => {
    const context = {
      targetingKey: 'private-subject',
      text: 'raw',
      bool: false,
      number: 1.5,
      nothing: null,
      nested: { value: 'before' },
      list: ['one', 2],
      date: new Date('2026-09-21T00:00:00.000Z'),
    }
    const result = snapshotEvaluationContext(context)
    assert.deepStrictEqual({ ...result.attrs }, {
      text: 'raw',
      bool: false,
      number: 1.5,
      nothing: null,
      'nested.value': 'before',
      'list.0': 'one',
      'list.1': 2,
      date: '2026-09-21T00:00:00.000Z',
    })
    assert.strictEqual(result.reasons.size, 0)
    context.nested.value = 'after'
    context.list[0] = 'after'
    context.date.setUTCFullYear(2000)
    assert.strictEqual(result.attrs['nested.value'], 'before')
    assert.strictEqual(result.attrs['list.0'], 'one')
    assert.strictEqual(result.attrs.date, '2026-09-21T00:00:00.000Z')
    assert(Object.isFrozen(result.attrs))
    assert.throws(() => { result.attrs.text = 'mutated' }, TypeError)
  })

  for (const count of [256, 257]) {
    it('retains the first 256 of ' + count + ' fields in natural order', () => {
      const context = Object.fromEntries(Array.from({ length: count }, (_, i) => ['field_' + (count - i), i]))
      const result = snapshotEvaluationContext(context)
      assert.strictEqual(Object.keys(result.attrs).length, 256)
      assert.deepStrictEqual(Object.keys(result.attrs), Object.keys(context).slice(0, 256))
      assert.strictEqual(result.reasons.has('max_context_fields'), count > 256)
    })

    it('bounds ' + count + ' list elements even when they are all skipped', () => {
      const list = Array(count).fill(undefined)
      list[255] = 'last'
      if (count > 256) list[256] = 'excluded'
      const result = snapshotEvaluationContext({ list, sibling: 'kept' })
      assert.deepStrictEqual({ ...result.attrs }, { 'list.255': 'last', sibling: 'kept' })
      assert.strictEqual(result.reasons.has('max_list_elements'), count > 256)
    })

    it('bounds ' + count + ' structure properties even when they are all skipped', () => {
      const nested = Object.fromEntries(Array.from({ length: count }, (_, i) => ['k' + i, undefined]))
      nested.k255 = 'last'
      if (count > 256) nested.k256 = 'excluded'
      const result = snapshotEvaluationContext({ nested, sibling: 'kept' })
      assert.deepStrictEqual({ ...result.attrs }, { 'nested.k255': 'last', sibling: 'kept' })
      assert.strictEqual(result.reasons.has('max_structure_properties'), count > 256)
    })
  }

  it('excludes targetingKey from the root property budget and never reads it', () => {
    const context = Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['k' + i, i]))
    Object.defineProperty(context, 'targetingKey', { enumerable: true, get () { throw new Error('targeting getter') } })
    const result = snapshotEvaluationContext(context)
    assert.strictEqual(Object.keys(result.attrs).length, 256)
    assert.strictEqual(result.reasons.size, 0)
    assert.strictEqual(Object.hasOwn(result.attrs, 'targetingKey'), false)
    assert.deepStrictEqual(attrs({ nested: { targetingKey: 'nested-attribute' } }), {
      'nested.targetingKey': 'nested-attribute',
    })
  })

  it('bounds the final flattened field count across separate branches', () => {
    const result = snapshotEvaluationContext({
      first: Array(200).fill('kept'), second: Array(200).fill('kept'),
    })
    assert.strictEqual(Object.keys(result.attrs).length, 256)
    assert.strictEqual(result.attrs['second.55'], 'kept')
    assert.strictEqual(Object.hasOwn(result.attrs, 'second.56'), false)
    assert(result.reasons.has('max_context_fields'))
  })

  for (const length of [256, 257]) {
    it('accepts or skips a ' + length + '-unit key without truncating it', () => {
      const key = 'k'.repeat(length)
      const result = snapshotEvaluationContext({ [key]: 'value', sibling: 'kept' })
      assert.strictEqual(Object.hasOwn(result.attrs, key), length === 256)
      assert.strictEqual(result.attrs.sibling, 'kept')
      assert.strictEqual(result.reasons.has('max_key_length'), length > 256)
    })
    it('accepts or skips a ' + length + '-unit string without truncating it', () => {
      const value = 'v'.repeat(length)
      const result = snapshotEvaluationContext({ value, sibling: 'kept' })
      assert.strictEqual(result.attrs.value, length === 256 ? value : undefined)
      assert.strictEqual(result.attrs.sibling, 'kept')
      assert.strictEqual(result.reasons.has('max_value_length'), length > 256)
    })
  }

  it('applies key bounds to the full flattened path', () => {
    const prefix = 'p'.repeat(254)
    const result = snapshotEvaluationContext({ [prefix]: { a: 'yes', ab: 'no' }, sibling: 'kept' })
    assert.strictEqual(result.attrs[prefix + '.a'], 'yes')
    assert.strictEqual(Object.hasOwn(result.attrs, prefix + '.ab'), false)
    assert(result.reasons.has('max_key_length'))
    assert.strictEqual(result.attrs.sibling, 'kept')
  })

  it('counts astral characters in UTF-16 code units', () => {
    const accepted = '\ud83d\ude00'.repeat(128)
    const result = snapshotEvaluationContext({ [accepted]: accepted, tooLong: accepted + 'x' })
    assert.strictEqual(result.attrs[accepted], accepted)
    assert.strictEqual(Object.hasOwn(result.attrs, 'tooLong'), false)
  })

  it('preserves scalar leaves at depth four and skips deeper containers', () => {
    const result = snapshotEvaluationContext({ a: { b: { c: { d: { leaf: 1, deeper: { leaf: 2 } } } } }, valid: 3 })
    assert.deepStrictEqual({ ...result.attrs }, { 'a.b.c.d.leaf': 1, valid: 3 })
    assert(result.reasons.has('max_snapshot_depth'))
  })

  it('breaks ancestor cycles while retaining shared siblings', () => {
    const shared = { value: 'kept' }
    const context = { first: shared, second: shared }
    context.self = context
    const result = snapshotEvaluationContext(context)
    assert.deepStrictEqual({ ...result.attrs }, { 'first.value': 'kept', 'second.value': 'kept' })
    assert(result.reasons.has('cycle'))
  })

  it('omits accessors without invoking them and preserves their siblings', () => {
    const nested = { sibling: 1 }
    Object.defineProperty(nested, 'hostile', { enumerable: true, get () { throw new Error('getter must not run') } })
    const result = snapshotEvaluationContext({ nested })
    assert.deepStrictEqual({ ...result.attrs }, { 'nested.sibling': 1 })
    assert(result.reasons.has('unsupported_type'))
  })

  it('skips hostile/revoked proxies without invoking traps or losing valid siblings', () => {
    const hostile = new Proxy({}, { ownKeys () { assert.fail('must not enumerate a proxy') } })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const result = snapshotEvaluationContext({ hostile, revoked: revoked.proxy, sibling: 1 })
    assert.deepStrictEqual({ ...result.attrs }, { sibling: 1 })
    assert(result.reasons.has('unsupported_type'))
    assert.deepStrictEqual(attrs(hostile), {})
    assert.deepStrictEqual(attrs(revoked.proxy), {})
  })

  it('skips unsupported values, invalid dates, and non-finite numbers without coercion', () => {
    const result = snapshotEvaluationContext({
      missing: undefined,
      fn () { assert.fail('must not run') },
      symbol: Symbol('value'),
      bigint: 1n,
      map: new Map([['key', 'value']]),
      set: new Set([1]),
      buffer: Buffer.from('value'),
      invalidDate: new Date(NaN),
      nan: NaN,
      infinite: Infinity,
      sibling: true,
    })
    assert.deepStrictEqual({ ...result.attrs }, { sibling: true })
    assert(result.reasons.has('unsupported_type'))
  })

  it('uses Date intrinsics rather than caller overrides', () => {
    const date = new Date('2026-09-21T00:00:00.000Z')
    date.toISOString = () => assert.fail('caller method')
    date.toJSON = () => assert.fail('caller method')
    assert.deepStrictEqual(attrs({ date }), { date: '2026-09-21T00:00:00.000Z' })
  })

  it('omits malformed Unicode keys and values without replacing them', () => {
    const result = snapshotEvaluationContext({ '\ud800': 'invalid', value: '\udc00', sibling: '\ufffd' })
    assert.deepStrictEqual({ ...result.attrs }, { sibling: '\ufffd' })
    assert(result.reasons.has('invalid_encoding'))
  })

  it('retains own special property names without prototype mutation or inherited data', () => {
    const context = JSON.parse(
      '{"__proto__":"kept","constructor":1,"toString":false,"nul\\u0000key":"nul\\u0000value"}'
    )
    const result = snapshotEvaluationContext(context)
    assert.strictEqual(Object.getPrototypeOf(result.attrs), null)
    assert.deepStrictEqual({ ...result.attrs }, context)
    assert.strictEqual(Object.hasOwn(result.attrs, 'hasOwnProperty'), false)
  })

  it('keeps only own enumerable data properties', () => {
    const context = { kept: 1, [Symbol('hidden')]: 'hidden' }
    Object.defineProperty(context, 'hidden', { value: 'hidden', enumerable: false })
    assert.deepStrictEqual(attrs(context), { kept: 1 })
  })

  it('does not invoke a custom array iterator or inspect out-of-budget elements', () => {
    const array = Array(257).fill(undefined)
    array[0] = 'kept'
    array[Symbol.iterator] = () => assert.fail('iterator must not run')
    Object.defineProperty(array, '256', { get () { throw new Error('out-of-budget getter') } })
    const descriptorSpy = sinon.spy(Object, 'getOwnPropertyDescriptor')
    let result
    try {
      result = snapshotEvaluationContext({ array })
      assert.strictEqual(descriptorSpy.getCalls().filter(call => call.args[0] === array).length, 256)
    } finally {
      descriptorSpy.restore()
    }
    assert.deepStrictEqual({ ...result.attrs }, { 'array.0': 'kept' })
    assert(result.reasons.has('max_list_elements'))
  })

  for (const count of [251, 252]) {
    it('charges skipped nodes against the 1,280-node budget (last array length ' + count + ')', () => {
      const context = {
        a: Array(256).fill(undefined),
        b: Array(256).fill(undefined),
        c: Array(256).fill(undefined),
        d: Array(256).fill(undefined),
        e: Array(count).fill(undefined),
      }
      context.e[250] = 'last-permitted'
      if (count > 251) context.e[251] = 'outside-budget'
      const result = snapshotEvaluationContext(context)
      assert.deepStrictEqual({ ...result.attrs }, { 'e.250': 'last-permitted' })
      assert.strictEqual(result.reasons.has('max_visited_nodes'), count > 251)
    })
  }

  it('uses deterministic last-write semantics for colliding flattened paths', () => {
    assert.deepStrictEqual(attrs({ a: { b: 1 }, 'a.b': 2 }), { 'a.b': 2 })
    assert.deepStrictEqual(attrs({ 'a.b': 2, a: { b: 1 } }), { 'a.b': 1 })
  })

  it('treats null or absent root context as empty', () => {
    for (const value of [null, undefined]) {
      const result = snapshotEvaluationContext(value)
      assert.deepStrictEqual({ ...result.attrs }, {})
      assert.strictEqual(result.reasons.size, 0)
    }
  })

  describe('canonical identity of the emitted snapshot', () => {
    it('ignores input insertion order when the retained fields match', () => {
      const first = snapshotEvaluationContext({ b: 2, a: 1 }).attrs
      const second = snapshotEvaluationContext({ a: 1, b: 2 }).attrs
      assert.strictEqual(canonicalContextKey(first), canonicalContextKey(second))
    })

    it('distinguishes scalar types, nulls, and embedded delimiters', () => {
      const fixtures = [
        { x: 1 }, { x: '1' }, { x: true }, { x: 'true' }, { x: null }, { x: 'null' },
        { 'x\0y': 'z' }, { x: 'y\0z' }, { x: 'a:b' }, { 'x:a': 'b' }, {},
      ]
      const identities = fixtures.map(value => canonicalContextKey(snapshotEvaluationContext(value).attrs))
      assert.strictEqual(new Set(identities).size, fixtures.length)
    })

    it('keys only the emitted fields, including JSON-equivalent zero values', () => {
      assert.strictEqual(
        canonicalContextKey(snapshotEvaluationContext({ x: -0, skipped: undefined }).attrs),
        canonicalContextKey(snapshotEvaluationContext({ x: 0 }).attrs)
      )
      assert.strictEqual(
        canonicalContextKey(snapshotEvaluationContext({ x: 1, secret: 's'.repeat(257) }).attrs),
        canonicalContextKey(snapshotEvaluationContext({ x: 1 }).attrs)
      )
    })
  })
})
