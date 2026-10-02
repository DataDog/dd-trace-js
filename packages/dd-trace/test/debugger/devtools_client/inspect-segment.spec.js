'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')

require('../../setup/mocha')

const createInspectSegment = require('../../../src/debugger/inspect-segment')
const { createIsRedactedIdentifier } = require('../../../src/debugger/redaction')

const inspectSegment = createInspectSegment(createIsRedactedIdentifier({
  DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: [],
  DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: [],
}))

// Whether symbol keys are wrapped in brackets differs between Node.js versions
const tokenSymbolKey = inspect({ [Symbol('token')]: 0 }).slice(2, -5)
const idSymbolKey = inspect({ [Symbol('id')]: 0 }).slice(2, -5)

describe('inspectSegment', function () {
  it('limits collections and enumerable object properties', function () {
    const fiveProperties = { a: 1, b: 2, c: 3, d: 4, e: 5 }
    Object.defineProperty(fiveProperties, 'hidden', { value: 6 })
    const sixProperties = { ...fiveProperties, f: 6 }

    assert.strictEqual(inspectSegment(42), '42')
    assert.strictEqual(inspectSegment([1, 2, 3, 4]), '[ 1, 2, 3, ... 1 more item ]')
    assert.strictEqual(inspectSegment(new Set([1, 2, 3])), 'Set(3) { 1, 2, 3 }')
    assert.strictEqual(inspectSegment(new Set([1, 2, 3, 4])), 'Set(4) { 1, 2, 3, ... 1 more item }')
    assert.strictEqual(inspectSegment(new Set([1, 2, 3, 4, 5])), 'Set(5) { 1, 2, 3, ... 2 more items }')
    assert.strictEqual(inspectSegment(new Map([[1, 2], [3, 4], [5, 6]])), 'Map(3) { 1 => 2, 3 => 4, 5 => 6 }')
    assert.strictEqual(
      inspectSegment(new Map([[1, 2], [3, 4], [5, 6], [7, 8]])),
      'Map(4) { 1 => 2, 3 => 4, 5 => 6, ... 1 more item }'
    )
    assert.strictEqual(
      inspectSegment(new Map([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]])),
      'Map(5) { 1 => 2, 3 => 4, 5 => 6, ... 2 more items }'
    )
    assert.strictEqual(inspectSegment(fiveProperties), '{ a: 1, b: 2, c: 3, d: 4, e: 5 }')
    assert.strictEqual(
      inspectSegment(sixProperties),
      '{ a: 1, b: 2, c: 3, d: 4, e: 5, ... 1 more property }'
    )
  })

  it('does not invoke proxy traps', function () {
    const proxy = new Proxy({}, {
      ownKeys () {
        throw new Error('Proxy trap should not run')
      },
    })
    const objectWithProxyPrototype = Object.create(new Proxy({}, {
      getPrototypeOf () {
        throw new Error('Proxy prototype trap should not run')
      },
    }))
    Object.assign(objectWithProxyPrototype, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })

    assert.strictEqual(inspectSegment(proxy), '[Proxy]')
    assert.strictEqual(
      inspectSegment(objectWithProxyPrototype),
      '{ a: 1, b: 2, c: 3, d: 4, e: 5, ... 1 more property }'
    )
  })

  it('does not invoke Symbol.toStringTag getters or custom inspection functions', function () {
    let customInspectCalled = false
    const value = {
      get [Symbol.toStringTag] () {
        throw new Error('Symbol.toStringTag getter should not run')
      },
      [inspect.custom] () {
        customInspectCalled = true
        return 'custom'
      },
    }

    assert.strictEqual(inspectSegment(value), '[Value omitted: inspection may execute user code]')
    assert.strictEqual(customInspectCalled, false)
  })

  it('omits wide objects containing values whose inspection may run user code', function () {
    const sideEffectfulValue = {
      get [Symbol.toStringTag] () {
        throw new Error('Symbol.toStringTag getter should not run')
      },
    }
    const value = { a: sideEffectfulValue, b: 2, c: 3, d: 4, e: 5, f: 6 }

    assert.strictEqual(inspectSegment(value), '[Value omitted: inspection may execute user code]')
  })

  it('preserves circular references when truncating objects', function () {
    const value = { circular: undefined, a: 1, b: 2, c: 3, d: 4, e: 5 }
    value.circular = value

    assert.strictEqual(
      inspectSegment(value),
      '<ref *1> { circular: [Circular *1], a: 1, b: 2, c: 3, d: 4, ... 1 more property }'
    )
  })

  it('preserves direct circular references when limiting collections', function () {
    const set = new Set()
    set.add(set).add(1).add(2).add(3)
    const map = new Map()
    map.set(map, map).set(1, 2).set(3, 4).set(5, 6)

    assert.strictEqual(
      inspectSegment(set),
      '<ref *1> Set(4) { [Circular *1], 1, 2, ... 1 more item }'
    )
    assert.strictEqual(
      inspectSegment(map),
      '<ref *1> Map(4) { [Circular *1] => [Circular *1], 1 => 2, 3 => 4, ... 1 more item }'
    )
  })

  describe('redaction', function () {
    it('redacts the values of redacted properties', function () {
      const symbolKeyed = { name: 'alice', [Symbol('token')]: 'secret' }

      assert.strictEqual(
        inspectSegment({ name: 'alice', password: 'hunter2' }),
        "{ name: 'alice', password: '{redacted}' }"
      )
      assert.strictEqual(inspectSegment(symbolKeyed), `{ name: 'alice', ${tokenSymbolKey}: '{redacted}' }`)
      assert.strictEqual(inspectSegment({ 'X-Auth-Token': 'secret' }), "{ 'X-Auth-Token': '{redacted}' }")
    })

    it('inspects a plain object copy of redacted objects that are not plain objects', function () {
      class User {
        name = 'alice'
        password = 'hunter2'
      }
      function handler () {}
      handler.apiKey = 'secret'
      // Built-ins with internal slots can't be inspected through an object that only shares their prototype
      const url = new URL('https://example.com/')
      Object.assign(url, { token: 'secret' })

      assert.strictEqual(inspectSegment(new User()), "{ name: 'alice', password: '{redacted}' }")
      assert.strictEqual(inspectSegment(handler), "{ apiKey: '{redacted}' }")
      // On Node.js 18, URLs also have an enumerable `Symbol(context)` property
      assert.match(inspectSegment(url), /^\{ token: '\{redacted\}'(?: \}|, \[Symbol\(context\)\]: \[URLContext\] \})$/)
    })

    it('does not copy objects without redacted properties', function () {
      function handler () {}
      handler.retries = 3

      assert.strictEqual(inspectSegment({ name: 'alice', [Symbol('id')]: 1 }), `{ name: 'alice', ${idSymbolKey}: 1 }`)
      assert.strictEqual(inspectSegment(handler), '[Function: handler] { retries: 3 }')
    })

    it('redacts the values of redacted properties when truncating objects', function () {
      const value = { a: 1, password: 'hunter2', b: 2, c: 3, d: 4, token: 'secret' }

      assert.strictEqual(
        inspectSegment(value),
        "{ a: 1, password: '{redacted}', b: 2, c: 3, d: 4, ... 1 more property }"
      )
    })

    it('omits redacted objects containing values whose inspection may run user code', function () {
      const sideEffectfulValue = {
        get [Symbol.toStringTag] () {
          throw new Error('Symbol.toStringTag getter should not run')
        },
      }

      assert.strictEqual(
        inspectSegment({ password: 'hunter2', a: sideEffectfulValue }),
        '[Value omitted: inspection may execute user code]'
      )
    })

    it('does not inspect the values of redacted properties when truncating objects', function () {
      const sideEffectfulValue = new Proxy({}, {})
      const value = { password: sideEffectfulValue, a: 1, b: 2, c: 3, d: 4, e: 5 }

      assert.strictEqual(
        inspectSegment(value),
        "{ password: '{redacted}', a: 1, b: 2, c: 3, d: 4, ... 1 more property }"
      )
    })

    it('preserves circular references when redacting objects', function () {
      /** @type {{ circular: unknown, password: string }} */
      const value = { circular: undefined, password: 'hunter2' }
      value.circular = value

      assert.strictEqual(inspectSegment(value), "<ref *1> { circular: [Circular *1], password: '{redacted}' }")
    })

    it('redacts the values of Map entries with redacted keys', function () {
      const map = new Map().set('name', 'alice').set('password', 'hunter2').set(Symbol('token'), 'secret')

      assert.strictEqual(
        inspectSegment(map),
        "Map(3) { 'name' => 'alice', 'password' => '{redacted}', Symbol(token) => '{redacted}' }"
      )
      assert.strictEqual(
        inspectSegment(new Map().set('password', 'hunter2').set(1, 2).set(3, 4).set(5, 6).set(7, 8)),
        "Map(5) { 'password' => '{redacted}', 1 => 2, 3 => 4, ... 2 more items }"
      )
    })

    it('only redacts Map entries keyed by strings or symbols', function () {
      const key = { password: 'hunter2' }

      assert.strictEqual(
        inspectSegment(new Map().set(key, 'value').set(2, 'two')),
        "Map(2) { [Object] => 'value', 2 => 'two' }"
      )
    })

    it('preserves circular references when redacting Maps', function () {
      const map = new Map()
      map.set(map, map).set('password', 'hunter2')

      assert.strictEqual(
        inspectSegment(map),
        "<ref *1> Map(2) { [Circular *1] => [Circular *1], 'password' => '{redacted}' }"
      )
    })

    it('honors the configured redacted and excluded identifiers', function () {
      const inspectSegment = createInspectSegment(createIsRedactedIdentifier({
        DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: ['foo'],
        DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: ['password'],
      }))

      assert.strictEqual(inspectSegment({ foo: 1, password: 'hunter2' }), "{ foo: '{redacted}', password: 'hunter2' }")
      assert.strictEqual(
        inspectSegment(new Map().set('foo', 1).set('password', 'hunter2')),
        "Map(2) { 'foo' => '{redacted}', 'password' => 'hunter2' }"
      )
    })
  })
})
