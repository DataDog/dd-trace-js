'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  beforeEach(enable(__filename))

  afterEach(teardown)

  describe('scopes', function () {
    it('should capture expected scopes', function (done) {
      assertOnBreakpoint(done, (state) => {
        assert.strictEqual(Object.entries(state).length, 5)

        assert.ok('a1' in state);
assert.deepStrictEqual(state['a1'], { type: 'number', value: '1' })
        assert.ok('a2' in state);
assert.deepStrictEqual(state['a2'], { type: 'number', value: '2' })
        assert.ok('total' in state);
assert.deepStrictEqual(state['total'], { type: 'number', value: '0' })
        assert.ok('i' in state);
assert.deepStrictEqual(state['i'], { type: 'number', value: '0' })
        assert.ok('inc' in state);
assert.deepStrictEqual(state['inc'], { type: 'number', value: '2' })
      })

      setAndTriggerBreakpoint(target, 13)
    })
  })
})
