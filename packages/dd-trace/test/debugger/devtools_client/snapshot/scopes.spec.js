'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  beforeEach(enable(__filename))

  afterEach(teardown)

  describe('scopes', function () {
    it('should capture expected scopes', function (done) {
      assertOnBreakpoint(done, (state) => {
        expect(Object.entries(state).length).to.equal(5)

        expect(state).to.have.deep.property('a1', { type: 'number', value: '1' })
        expect(state).to.have.deep.property('a2', { type: 'number', value: '2' })
        expect(state).to.have.deep.property('total', { type: 'number', value: '0' })
        expect(state).to.have.deep.property('i', { type: 'number', value: '0' })
        expect(state).to.have.deep.property('inc', { type: 'number', value: '2' })
      })

      setAndTriggerBreakpoint(target, 13)
    })
  })
})
