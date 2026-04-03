'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../../../../integration-tests/helpers')
require('../../../setup/mocha')

const {
  LARGE_OBJECT_SKIP_THRESHOLD,
  DEFAULT_MAX_COLLECTION_SIZE,
} = require('../../../../src/debugger/devtools_client/snapshot/constants')
const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxCollectionSize', function () {
    const configs = [
      undefined,
      { maxCollectionSize: 3 },
    ]

    beforeEach(enable(__filename))

    afterEach(teardown)

    for (const config of configs) {
      const maxCollectionSize = config?.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE
      const postfix = config === undefined ? 'not set' : `set to ${config.maxCollectionSize}`

      describe(`should respect the default maxCollectionSize if ${postfix}`, function () {
        let state

        const expectedElements = []
        const expectedEntries = []
        for (let i = 1; i <= maxCollectionSize; i++) {
          expectedElements.push({ type: 'number', value: i.toString() })
          expectedEntries.push([
            { type: 'number', value: i.toString() },
            {
              type: 'Object',
              fields: { i: { type: 'number', value: i.toString() } },
            },
          ])
        }

        beforeEach(function (done) {
          assertOnBreakpoint(done, config, (_state) => {
            state = _state
          })
          setAndTriggerBreakpoint(target, 29)
        })

        it('should have expected number of elements in state', function () {
          assert.deepStrictEqual(
            Object.keys(state).sort(),
            ['LARGE_SIZE', 'arr', 'map', 'set', 'typedArray', 'wmap', 'wset']
          )
        })

        it('Array', function () {
          assert.ok('arr' in state)
          assert.deepStrictEqual(state.arr, {
            type: 'Array',
            elements: expectedElements,
            notCapturedReason: 'collectionSize',
            size: LARGE_OBJECT_SKIP_THRESHOLD - 1,
          })
        })

        it('Map', function () {
          assert.ok('map' in state)
          assert.deepStrictEqual(state.map, {
            type: 'Map',
            entries: expectedEntries,
            notCapturedReason: 'collectionSize',
            size: LARGE_OBJECT_SKIP_THRESHOLD - 1,
          })
        })

        it('Set', function () {
          assert.ok('set' in state)
          assert.deepStrictEqual(state.set, {
            type: 'Set',
            elements: expectedElements,
            notCapturedReason: 'collectionSize',
            size: LARGE_OBJECT_SKIP_THRESHOLD - 1,
          })
        })

        it('WeakMap', function () {
          assertObjectContains(state.wmap, {
            type: 'WeakMap',
            notCapturedReason: 'collectionSize',
            size: LARGE_OBJECT_SKIP_THRESHOLD - 1,
          })

          assert.strictEqual(state.wmap.entries.length, maxCollectionSize)

          // The order of the entries is not guaranteed, so we don't know which were removed
          for (const entry of state.wmap.entries) {
            assert.strictEqual(entry.length, 2)
            assert.strictEqual(entry[0].type, 'Object')
            assert.ok(Object.hasOwn(entry[0].fields, 'i'))
            assert.strictEqual(entry[0].fields.i.type, 'number')
            assert.ok(Object.hasOwn(entry[0].fields.i, 'value'))
            assert.match(entry[0].fields.i.value, /^\d+$/)
            assert.strictEqual(entry[1].type, 'number')
            assert.strictEqual(entry[1].value, entry[0].fields.i.value)
          }
        })

        it('WeakSet', function () {
          assertObjectContains(state.wset, {
            type: 'WeakSet',
            notCapturedReason: 'collectionSize',
            size: LARGE_OBJECT_SKIP_THRESHOLD - 1,
          })

          assert.strictEqual(state.wset.elements.length, maxCollectionSize)

          // The order of the elements is not guaranteed, so we don't know which were removed
          for (const element of state.wset.elements) {
            assert.strictEqual(element.type, 'Object')
            assert.ok(Object.hasOwn(element.fields, 'i'))
            assert.strictEqual(element.fields.i.type, 'number')
            assert.ok(Object.hasOwn(element.fields.i, 'value'))
            assert.match(element.fields.i.value, /^\d+$/)
          }
        })

        it('TypedArray', function () {
          assert.ok('typedArray' in state)
          assert.deepStrictEqual(state.typedArray, {
            type: 'Uint16Array',
            elements: expectedElements,
            notCapturedReason: 'collectionSize',
            size: LARGE_OBJECT_SKIP_THRESHOLD - 1,
          })
        })
      })
    }
  })
})
