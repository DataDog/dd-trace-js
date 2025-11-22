'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('primitives', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    it('should return expected object for primitives', function (done) {
      assertOnBreakpoint(done, (state) => {
        assert.strictEqual(Object.keys(state).length, 7)
        assert.ok('undef' in state);
assert.deepStrictEqual(state['undef'], { type: 'undefined' })
        assert.ok('nil' in state);
assert.deepStrictEqual(state['nil'], { type: 'null', isNull: true })
        assert.ok('bool' in state);
assert.deepStrictEqual(state['bool'], { type: 'boolean', value: 'true' })
        assert.ok('num' in state);
assert.deepStrictEqual(state['num'], { type: 'number', value: '42' })
        assert.ok('bigint' in state);
assert.deepStrictEqual(state['bigint'], { type: 'bigint', value: '18014398509481982' })
        assert.ok('str' in state);
assert.deepStrictEqual(state['str'], { type: 'string', value: 'foo' })
        assert.ok('sym' in state);
assert.deepStrictEqual(state['sym'], { type: 'symbol', value: 'Symbol(foo)' })
      })

      setAndTriggerBreakpoint(target, 13)
    })
  })
})
