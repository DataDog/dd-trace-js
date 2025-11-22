'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxReferenceDepth', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    it('should return expected object for nested objects with maxReferenceDepth: 1', function (done) {
      assertOnBreakpoint(done, { maxReferenceDepth: 1 }, (state) => {
        assert.strictEqual(Object.keys(state).length, 1)

        assert.ok(Object.hasOwn(state, 'myNestedObj'))
        assert.strictEqual(state.myNestedObj.type, 'Object')
        assert.ok(Object.hasOwn(state.myNestedObj, 'fields'))
        assert.strictEqual(Object.keys(state.myNestedObj).length, 2)

        assert.ok('deepObj' in state.myNestedObj.fields);
assert.deepStrictEqual(state.myNestedObj.fields['deepObj'], {
          type: 'Object', notCapturedReason: 'depth'
        })

        assert.ok('deepArr' in state.myNestedObj.fields);
assert.deepStrictEqual(state.myNestedObj.fields['deepArr'], {
          type: 'Array', notCapturedReason: 'depth'
        })
      })

      setAndTriggerBreakpoint(target, 9)
    })

    it('should return expected object for nested objects with maxReferenceDepth: 5', function (done) {
      assertOnBreakpoint(done, { maxReferenceDepth: 5 }, (state) => {
        assert.strictEqual(Object.entries(state).length, 1)

        assert.ok(Object.hasOwn(state, 'myNestedObj'))
        assert.strictEqual(state.myNestedObj.type, 'Object')
        assert.ok(Object.hasOwn(state.myNestedObj, 'fields'))
        assert.strictEqual(Object.entries(state.myNestedObj).length, 2)

        assert.ok('deepObj' in state.myNestedObj.fields);
assert.deepStrictEqual(state.myNestedObj.fields['deepObj'], {
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

        assert.ok('deepArr' in state.myNestedObj.fields);
assert.deepStrictEqual(state.myNestedObj.fields['deepArr'], {
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
        assert.strictEqual(Object.entries(state).length, 1)

        assert.ok(Object.hasOwn(state, 'myNestedObj'))
        assert.strictEqual(state.myNestedObj.type, 'Object')
        assert.ok(Object.hasOwn(state.myNestedObj, 'fields'))
        assert.strictEqual(Object.entries(state.myNestedObj).length, 2)

        assert.ok('deepObj' in state.myNestedObj.fields);
assert.deepStrictEqual(state.myNestedObj.fields['deepObj'], {
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

        assert.ok('deepArr' in state.myNestedObj.fields);
assert.deepStrictEqual(state.myNestedObj.fields['deepArr'], {
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
