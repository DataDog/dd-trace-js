'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
module.exports = ({ Assertion, expect }, { expectTypes }) => {
  Assertion.addProperty('valueType', function () {
    const obj = this._obj

    assert.ok(typeof obj === 'object' && obj !== null, `Expected non-null object, got ${inspect(obj)}`)
    assert.strictEqual(typeof obj.type, 'number')
    assert.strictEqual(typeof obj.unit, 'number')
  })

  Assertion.addProperty('numeric', function () {
    expectTypes(this, ['number', 'bigint'])
  })

  Assertion.addProperty('profile', function () {
    const obj = this._obj

    assert.ok(typeof obj === 'object' && obj !== null, `Expected non-null object, got ${inspect(obj)}`)

    assert.strictEqual(typeof obj.timeNanos, 'bigint')
    expect(obj.period).to.be.numeric
    expect(obj.periodType).to.be.a.valueType
    assert.ok(Array.isArray(obj.sampleType), `Expected array, got ${inspect(obj.sampleType)}`)
    assert.strictEqual(obj.sampleType.length, 2)
    assert.ok(Array.isArray(obj.sample), `Expected array, got ${inspect(obj.sample)}`)
    assert.ok(Array.isArray(obj.location), `Expected array, got ${inspect(obj.location)}`)
    assert.ok(Array.isArray(obj.function), `Expected array, got ${inspect(obj.function)}`)
    assert.ok(Array.isArray(obj.stringTable.strings), `Expected array, got ${inspect(obj.stringTable.strings)}`)
    assert.ok(obj.stringTable.strings.length >= 1, `Expected ${obj.stringTable.strings.length} >= 1`)
    assert.strictEqual(obj.stringTable.strings[0], '')

    for (const sampleType of obj.sampleType) {
      expect(sampleType).to.be.a.valueType
    }

    for (const fn of obj.function) {
      assert.strictEqual(typeof fn.filename, 'number')
      assert.strictEqual(typeof fn.systemName, 'number')
      assert.strictEqual(typeof fn.name, 'number')
      assert.ok(Number.isSafeInteger(fn.id), `Expected isSafeInteger, got ${inspect(fn.id)}`)
    }

    for (const location of obj.location) {
      assert.ok(Number.isSafeInteger(location.id), `Expected isSafeInteger, got ${inspect(location.id)}`)
      assert.ok(Array.isArray(location.line), `Expected array, got ${inspect(location.line)}`)

      for (const line of location.line) {
        assert.ok(Number.isSafeInteger(line.functionId), `Expected isSafeInteger, got ${inspect(line.functionId)}`)
        assert.strictEqual(typeof line.line, 'number')
      }
    }

    for (const sample of obj.sample) {
      assert.ok(Array.isArray(sample.locationId), `Expected array, got ${inspect(sample.locationId)}`)
      assert.ok(sample.locationId.length >= 1, `Expected ${sample.locationId.length} >= 1`)
      assert.ok(Array.isArray(sample.value), `Expected array, got ${inspect(sample.value)}`)
      assert.strictEqual(sample.value.length, obj.sampleType.length)
    }
  })
}
