'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('primitives', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    it('should return expected object for primitives', function (done) {
      assertOnBreakpoint(done, (state) => {
        expect(Object.keys(state).length).to.equal(7)
        expect(state).to.have.deep.property('undef', { type: 'undefined' })
        expect(state).to.have.deep.property('nil', { type: 'null', isNull: true })
        expect(state).to.have.deep.property('bool', { type: 'boolean', value: 'true' })
        expect(state).to.have.deep.property('num', { type: 'number', value: '42' })
        expect(state).to.have.deep.property('bigint', { type: 'bigint', value: '18014398509481982' })
        expect(state).to.have.deep.property('str', { type: 'string', value: 'foo' })
        expect(state).to.have.deep.property('sym', { type: 'symbol', value: 'Symbol(foo)' })
      })

      setAndTriggerBreakpoint(target, 13)
    })
  })
})
