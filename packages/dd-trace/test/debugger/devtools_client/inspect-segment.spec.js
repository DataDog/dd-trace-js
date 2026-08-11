'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')

require('../../setup/mocha')

const inspectSegment = require('../../../src/debugger/inspect-segment')

describe('inspectSegment', function () {
  it('limits collections and enumerable object properties', function () {
    const fiveProperties = { a: 1, b: 2, c: 3, d: 4, e: 5 }
    Object.defineProperty(fiveProperties, 'hidden', { value: 6 })
    const sixProperties = { ...fiveProperties, f: 6 }

    assert.strictEqual(inspectSegment(42), '42')
    assert.strictEqual(inspectSegment([1, 2, 3, 4]), '[ 1, 2, 3, ... 1 more item ]')
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
})
