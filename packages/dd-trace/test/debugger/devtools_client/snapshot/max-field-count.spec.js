'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const DEFAULT_MAX_FIELD_COUNT = 20
const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxFieldCount', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    describe('shold respect the default maxFieldCount if not set', generateTestCases())

    describe('shold respect maxFieldCount if set to 10', generateTestCases({ maxFieldCount: 10 }))
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
      expect(state).to.have.keys(['obj'])
      expect(state).to.have.deep.property('obj', {
        type: 'Object',
        fields: expectedFields,
        notCapturedReason: 'fieldCount',
        size: 40
      })
    })
  }
}
