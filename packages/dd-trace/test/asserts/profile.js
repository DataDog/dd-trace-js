'use strict'

const assert = require('node:assert/strict')
module.exports = ({ Assertion, expect }, { expectTypes }) => {
  Assertion.addProperty('valueType', function () {
    const obj = this._obj

    assert.ok(typeof obj === 'object' && obj !== null)
    assert.strictEqual(typeof obj.type, 'number')
    assert.strictEqual(typeof obj.unit, 'number')
  })

  Assertion.addProperty('numeric', function () {
    expectTypes(this, ['number', 'bigint'])
  })

  Assertion.addProperty('profile', function () {
    const obj = this._obj

    assert.ok(typeof obj === 'object' && obj !== null)

    assert.strictEqual(typeof obj.timeNanos, 'bigint')
    expect(obj.period).to.be.numeric
    expect(obj.periodType).to.be.a.valueType
    assert.ok(Array.isArray(obj.sampleType)).and.have.length(2)
    assert.ok(Array.isArray(obj.sample))
    assert.ok(Array.isArray(obj.location))
    assert.ok(Array.isArray(obj.function))
    assert.ok(Array.isArray(obj.stringTable.strings)).and.have.length.at.least(1)
    assert.strictEqual(obj.stringTable.strings[0], '')

    for (const sampleType of obj.sampleType) {
      expect(sampleType).to.be.a.valueType
    }

    for (const fn of obj.function) {
      assert.strictEqual(typeof fn.filename, 'number')
      assert.strictEqual(typeof fn.systemName, 'number')
      assert.strictEqual(typeof fn.name, 'number')
      assert.match(fn.id, /\d+/)
    }

    for (const location of obj.location) {
      assert.match(location.id, /\d+/)
      assert.ok(Array.isArray(location.line))

      for (const line of location.line) {
        assert.match(line.functionId, /\d+/)
        assert.strictEqual(typeof line.line, 'number')
      }
    }

    for (const sample of obj.sample) {
      assert.ok(Array.isArray(sample.locationId))
      assert.ok(sample.locationId.length >= 1)
      assert.ok(Array.isArray(sample.value)).and.have.length(obj.sampleType.length)
    }
  })
}
