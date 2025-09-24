'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxReferenceDepth', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    it('should return expected object for nested objects with maxReferenceDepth: 1', function (done) {
      assertOnBreakpoint(done, { maxReferenceDepth: 1 }, (state) => {
        expect(Object.keys(state).length).to.equal(1)

        expect(state).to.have.property('myNestedObj')
        expect(state.myNestedObj).to.have.property('type', 'Object')
        expect(state.myNestedObj).to.have.property('fields')
        expect(Object.keys(state.myNestedObj).length).to.equal(2)

        expect(state.myNestedObj.fields).to.have.deep.property('deepObj', {
          type: 'Object', notCapturedReason: 'depth'
        })

        expect(state.myNestedObj.fields).to.have.deep.property('deepArr', {
          type: 'Array', notCapturedReason: 'depth'
        })
      })

      setAndTriggerBreakpoint(target, 9)
    })

    it('should return expected object for nested objects with maxReferenceDepth: 5', function (done) {
      assertOnBreakpoint(done, { maxReferenceDepth: 5 }, (state) => {
        expect(Object.entries(state).length).to.equal(1)

        expect(state).to.have.property('myNestedObj')
        expect(state.myNestedObj).to.have.property('type', 'Object')
        expect(state.myNestedObj).to.have.property('fields')
        expect(Object.entries(state.myNestedObj).length).to.equal(2)

        expect(state.myNestedObj.fields).to.have.deep.property('deepObj', {
          type: 'Object',
          fields: {
            foo: {
              type: 'Object',
              fields: {
                foo: {
                  type: 'Object',
                  fields: {
                    foo: {
                      type: 'Object',
                      fields: {
                        foo: { type: 'Object', notCapturedReason: 'depth' }
                      }
                    }
                  }
                }
              }
            }
          }
        })

        expect(state.myNestedObj.fields).to.have.deep.property('deepArr', {
          type: 'Array',
          elements: [{
            type: 'Array',
            elements: [{
              type: 'Array',
              elements: [{
                type: 'Array',
                elements: [{ type: 'Array', notCapturedReason: 'depth' }]
              }]
            }]
          }]
        })
      })

      setAndTriggerBreakpoint(target, 9)
    })

    it('should return expected object for nested objects if maxReferenceDepth is missing', function (done) {
      assertOnBreakpoint(done, (state) => {
        expect(Object.entries(state).length).to.equal(1)

        expect(state).to.have.property('myNestedObj')
        expect(state.myNestedObj).to.have.property('type', 'Object')
        expect(state.myNestedObj).to.have.property('fields')
        expect(Object.entries(state.myNestedObj).length).to.equal(2)

        expect(state.myNestedObj.fields).to.have.deep.property('deepObj', {
          type: 'Object',
          fields: {
            foo: {
              type: 'Object',
              fields: {
                foo: {
                  type: 'Object',
                  notCapturedReason: 'depth'
                }
              }
            }
          }
        })

        expect(state.myNestedObj.fields).to.have.deep.property('deepArr', {
          type: 'Array',
          elements: [{
            type: 'Array',
            elements: [{
              type: 'Array',
              notCapturedReason: 'depth'
            }]
          }]
        })
      })

      setAndTriggerBreakpoint(target, 9)
    })
  })
})
