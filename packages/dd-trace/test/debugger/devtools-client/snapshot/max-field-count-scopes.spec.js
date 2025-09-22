'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxFieldCount', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    describe('shold respect maxFieldCount on each collected scope', function () {
      const maxFieldCount = 3
      let state

      beforeEach(function (done) {
        assertOnBreakpoint(done, { maxFieldCount }, (_state) => {
          state = _state
        })
        setAndTriggerBreakpoint(target, 11)
      })

      it('should capture expected snapshot', function () {
        // Expect the snapshot to have captured the first 3 fields from each scope
        expect(state).to.have.keys(['a1', 'b1', 'c1', 'a2', 'b2', 'c2'])
      })
    })
  })
})
