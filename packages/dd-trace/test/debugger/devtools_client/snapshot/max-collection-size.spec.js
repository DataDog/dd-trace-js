'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../../setup/mocha')

const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const DEFAULT_MAX_COLLECTION_SIZE = 100
const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('maxCollectionSize', function () {
    const configs = [
      undefined,
      { maxCollectionSize: 3 }
    ]

    beforeEach(enable(__filename))

    afterEach(teardown)

    for (const config of configs) {
      const maxCollectionSize = config?.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE
      const postfix = config === undefined ? 'not set' : `set to ${config.maxCollectionSize}`

      describe(`shold respect the default maxCollectionSize if ${postfix}`, function () {
        let state

        const expectedElements = []
        const expectedEntries = []
        for (let i = 1; i <= maxCollectionSize; i++) {
          expectedElements.push({ type: 'number', value: i.toString() })
          expectedEntries.push([
            { type: 'number', value: i.toString() },
            {
              type: 'Object',
              fields: { i: { type: 'number', value: i.toString() } }
            }
          ])
        }

        beforeEach(function (done) {
          assertOnBreakpoint(done, config, (_state) => {
            state = _state
          })
          setAndTriggerBreakpoint(target, 24)
        })

        it('should have expected number of elements in state', function () {
          expect(state).to.have.keys(['arr', 'map', 'set', 'wmap', 'wset', 'typedArray'])
        })

        it('Array', function () {
          expect(state).to.have.deep.property('arr', {
            type: 'Array',
            elements: expectedElements,
            notCapturedReason: 'collectionSize',
            size: 1000
          })
        })

        it('Map', function () {
          expect(state).to.have.deep.property('map', {
            type: 'Map',
            entries: expectedEntries,
            notCapturedReason: 'collectionSize',
            size: 1000
          })
        })

        it('Set', function () {
          expect(state).to.have.deep.property('set', {
            type: 'Set',
            elements: expectedElements,
            notCapturedReason: 'collectionSize',
            size: 1000
          })
        })

        it('WeakMap', function () {
          expect(state.wmap).to.include({
            type: 'WeakMap',
            notCapturedReason: 'collectionSize',
            size: 1000
          })

          expect(state.wmap.entries).to.have.lengthOf(maxCollectionSize)

          // The order of the entries is not guaranteed, so we don't know which were removed
          for (const entry of state.wmap.entries) {
            expect(entry).to.have.lengthOf(2)
            expect(entry[0]).to.have.property('type', 'Object')
            expect(entry[0].fields).to.have.property('i')
            expect(entry[0].fields.i).to.have.property('type', 'number')
            expect(entry[0].fields.i).to.have.property('value').to.match(/^\d+$/)
            expect(entry[1]).to.have.property('type', 'number')
            expect(entry[1]).to.have.property('value', entry[0].fields.i.value)
          }
        })

        it('WeakSet', function () {
          expect(state.wset).to.include({
            type: 'WeakSet',
            notCapturedReason: 'collectionSize',
            size: 1000
          })

          expect(state.wset.elements).to.have.lengthOf(maxCollectionSize)

          // The order of the elements is not guaranteed, so we don't know which were removed
          for (const element of state.wset.elements) {
            expect(element).to.have.property('type', 'Object')
            expect(element.fields).to.have.property('i')
            expect(element.fields.i).to.have.property('type', 'number')
            expect(element.fields.i).to.have.property('value').to.match(/^\d+$/)
          }
        })

        it('TypedArray', function () {
          expect(state).to.have.deep.property('typedArray', {
            type: 'Uint16Array',
            elements: expectedElements,
            notCapturedReason: 'collectionSize',
            size: 1000
          })
        })
      })
    }
  })
})
