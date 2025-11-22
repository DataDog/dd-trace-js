'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')
const { DEFAULT_MAX_FIELD_COUNT } = require('../../../../src/debugger/devtools_client/snapshot/constants')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxFieldCount', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    describe('should respect the default maxFieldCount if not set', generateTestCases())

    describe('should respect maxFieldCount if set to 10', generateTestCases({ maxFieldCount: 10 }))
  })
})

function generateTestCases (config) {
  const maxFieldCount = config?.maxFieldCount ?? DEFAULT_MAX_FIELD_COUNT
  let state

  const expectedFields = {}
  for (let i = 1; i <= maxFieldCount; i++) {
    expectedFields[`field${i}`] = { type: 'number', value: i.toString() }
  }

  return function () {
    beforeEach(function (done) {
      assertOnBreakpoint(done, config, (_state) => {
        state = _state
      })
      setAndTriggerBreakpoint(target, 11)
    })

    it('should capture expected snapshot', function () {
      assert.strictEqual(Object.keys(state).length, ((Array.isArray(['obj']) ? ['obj'] : [['obj']])).length)
assert.ok(((Array.isArray(['obj']) ? ['obj'] : [['obj']])).every(k => Object.hasOwn(state, k)))
      assert.ok('obj' in state);
assert.deepStrictEqual(state['obj'], {
        type: 'Object',
        fields: expectedFields,
        notCapturedReason: 'fieldCount',
        size: 40
      })
    })
  }
}
