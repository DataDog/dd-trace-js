'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { afterEach, beforeEach, describe, it } = require('mocha')
const { assertObjectContains } = require('../../../../../../integration-tests/helpers')

require('../../../setup/mocha')

const {
  session,
  getTargetCodePath,
  enable,
  teardown,
  setAndTriggerBreakpoint,
  getLocalStateForCallFrame
} = require('./utils')

const NODE_20_PLUS = require('semver').gte(process.version, '20.0.0')
const target = getTargetCodePath(__filename)

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('complex types', function () {
    let state

    beforeEach(enable(__filename))

    afterEach(teardown)

    beforeEach(async function () {
      let resolve
      const localState = new Promise((_resolve) => { resolve = _resolve })

      session.once('Debugger.paused', async ({ params }) => {
        assert.strictEqual(params.hitBreakpoints.length, 1)

        resolve((await getLocalStateForCallFrame(
          params.callFrames[0],
          { maxFieldCount: Number.MAX_SAFE_INTEGER })
        )())
      })

      await setAndTriggerBreakpoint(target, 10)

      state = await localState
    })

    it('should contain expected properties from closure scope', function () {
      assert.strictEqual(Object.keys(state).length, 28)

      // from block scope
      // ... tested individually in the remaining it-blocks inside this describe-block

      // from closure scope
      expect(state).to.have.deep.property('ref', {
        type: 'Object',
        fields: {
          wmo1: { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          wmo2: { type: 'Object', fields: { b: { type: 'number', value: '3' } } },
          wso1: { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          wso2: { type: 'Object', fields: { a: { type: 'number', value: '2' } } },
          wso3: { type: 'Object', fields: { a: { type: 'number', value: '3' } } }
        }
      })
      expect(state).to.have.deep.property('get', {
        type: 'Function',
        fields: {
          length: { type: 'number', value: '0' },
          name: { type: 'string', value: 'get' }
        }
      })
    })

    it('object literal', function () {
      expect(state).to.have.deep.property('oblit', {
        type: 'Object',
        fields: {
          a: { type: 'number', value: '1' },
          b_b: { type: 'number', value: '2' },
          'Symbol(c)': { type: 'number', value: '3' },
          d: { type: 'getter' },
          e: { type: 'getter' },
          f: { type: 'setter' },
          g: { type: 'getter/setter' }
        }
      })
    })

    it('custom object from class', function () {
      expect(state).to.have.deep.property('obnew', {
        type: 'MyClass',
        fields: {
          foo: { type: 'number', value: '42' },
          '#secret': { type: 'number', value: '42' }
        }
      })
    })

    it('Array', function () {
      expect(state).to.have.deep.property('arr', {
        type: 'Array',
        elements: [
          { type: 'number', value: '1' },
          { type: 'number', value: '2' },
          { type: 'number', value: '3' }
        ]
      })
    })

    it('RegExp', function () {
      expect(state).to.have.deep.property('regex', { type: 'RegExp', value: '/foo/' })
    })

    it('Date', function () {
      expect(state).to.have.deep.property('date', {
        type: 'Date',
        value: '2024-09-20T07:22:59Z' // missing milliseconds due to API limitation (should have been `998`)
      })
    })

    it('Map', function () {
      expect(state).to.have.deep.property('map', {
        type: 'Map',
        entries: [
          [{ type: 'number', value: '1' }, { type: 'number', value: '2' }],
          [{ type: 'number', value: '3' }, { type: 'number', value: '4' }]
        ]
      })
    })

    it('Set', function () {
      expect(state).to.have.deep.property('set', {
        type: 'Set',
        elements: [
          {
            type: 'Array',
            elements: [
              { type: 'number', value: '1' },
              { type: 'number', value: '2' }
            ]
          },
          { type: 'number', value: '3' },
          { type: 'number', value: '4' }
        ]
      })
    })

    it('WeakMap', function () {
      assert.ok(Object.hasOwn(state, 'wmap'))
      expect(state.wmap).to.have.keys('type', 'entries')
      assert.ok(Array.isArray(state.wmap.entries))
      state.wmap.entries = state.wmap.entries.sort((a, b) => a[1].value - b[1].value)
      expect(state).to.have.deep.property('wmap', {
        type: 'WeakMap',
        entries: [[
          { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          { type: 'number', value: '2' }
        ], [
          { type: 'Object', fields: { b: { type: 'number', value: '3' } } },
          { type: 'number', value: '4' }
        ]]
      })
    })

    it('WeakSet', function () {
      assert.ok(Object.hasOwn(state, 'wset'))
      expect(state.wset).to.have.keys('type', 'elements')
      assert.ok(Array.isArray(state.wset.elements))
      state.wset.elements = state.wset.elements.sort((a, b) => a.fields.a.value - b.fields.a.value)
      expect(state).to.have.deep.property('wset', {
        type: 'WeakSet',
        elements: [
          { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          { type: 'Object', fields: { a: { type: 'number', value: '2' } } },
          { type: 'Object', fields: { a: { type: 'number', value: '3' } } }
        ]
      })
    })

    it('Generator', function () {
      expect(state).to.have.deep.property('gen', {
        type: 'generator',
        fields: { foo: { type: 'number', value: '42' } }
      })
    })

    it('Error', function () {
      assert.ok(Object.hasOwn(state, 'err'))
      expect(state.err).to.have.keys('type', 'fields')
      assert.strictEqual(state.err.type, 'CustomError')
      assert.ok(typeof state.err.fields === 'object' && state.err.fields !== null)
      expect(state.err.fields).to.have.keys('stack', 'message', 'foo')
      expect(state.err.fields).to.deep.include({
        message: { type: 'string', value: 'boom!' },
        foo: { type: 'number', value: '42' }
      })
      expect(state.err.fields.stack).to.have.keys('type', 'value', 'truncated', 'size')
      assert.strictEqual(typeof state.err.fields.stack.value, 'string')
      assert.match(state.err.fields.stack.value, /^Error: boom!/)
      assert.strictEqual(typeof state.err.fields.stack.size, 'number')
      expect(state.err.fields.stack.size).to.above(255)
      assertObjectContains(state.err.fields.stack, {
        type: 'string',
        truncated: true
      })
    })

    it('Function', function () {
      expect(state).to.have.deep.property('fn', {
        type: 'Function',
        fields: {
          foo: {
            type: 'Object',
            fields: { bar: { type: 'number', value: '42' } }
          },
          length: { type: 'number', value: '2' },
          name: { type: 'string', value: 'fnWithProperties' }
        }
      })
    })

    it('Bound function', function () {
      expect(state).to.have.deep.property('bfn', {
        type: 'Function',
        fields: {
          length: { type: 'number', value: '0' },
          name: { type: 'string', value: 'bound fnWithProperties' }
        }
      })
    })

    it('Arrow function', function () {
      expect(state).to.have.deep.property('afn', {
        type: 'Function',
        fields: {
          length: { type: 'number', value: '0' },
          name: { type: 'string', value: 'afn' }
        }
      })
    })

    it('Class', function () {
      expect(state).to.have.deep.property('cls', { type: 'class MyClass' })
    })

    it('Anonymous class', function () {
      expect(state).to.have.deep.property('acls', { type: 'class' })
    })

    it('Proxy for object literal', function () {
      expect(state).to.have.deep.property('prox', {
        type: NODE_20_PLUS ? 'Proxy(Object)' : 'Proxy',
        fields: {
          target: { type: 'boolean', value: 'true' }
        }
      })
    })

    it('Proxy for custom class', function () {
      expect(state).to.have.deep.property('custProx', {
        type: NODE_20_PLUS ? 'Proxy(MyClass)' : 'Proxy',
        fields: {
          foo: { type: 'number', value: '42' }
        }
      })
    })

    it('Promise: Pending', function () {
      expect(state).to.have.deep.property('pPen', {
        type: 'Promise',
        fields: {
          '[[PromiseState]]': { type: 'string', value: 'pending' },
          '[[PromiseResult]]': { type: 'undefined' }
        }
      })
    })

    it('Promise: Resolved', function () {
      expect(state).to.have.deep.property('pRes', {
        type: 'Promise',
        fields: {
          '[[PromiseState]]': { type: 'string', value: 'fulfilled' },
          '[[PromiseResult]]': { type: 'string', value: 'resolved value' }
        }
      })
    })

    it('Promise: Rejected', function () {
      expect(state).to.have.deep.property('pRej', {
        type: 'Promise',
        fields: {
          '[[PromiseState]]': { type: 'string', value: 'rejected' },
          '[[PromiseResult]]': { type: 'string', value: 'rejected value' }
        }
      })
    })

    it('TypedArray', function () {
      expect(state).to.have.deep.property('tarr', {
        type: 'Int8Array',
        elements: [
          { type: 'number', value: '72' },
          { type: 'number', value: '65' },
          { type: 'number', value: '76' }
        ]
      })
    })

    it('ArrayBuffer', function () {
      expect(state).to.have.deep.property('ab', {
        type: 'ArrayBuffer',
        value: 'HAL'
      })
    })

    it('SharedArrayBuffer', function () {
      expect(state).to.have.deep.property('sab', {
        type: 'SharedArrayBuffer',
        value: 'hello\x01\x02\x03world'
      })
    })

    it('circular reference in object', function () {
      assert.ok(Object.hasOwn(state, 'circular'))
      assert.strictEqual(state.circular.type, 'Object')
      assert.ok(Object.hasOwn(state.circular, 'fields'))
      // For the circular field, just check that at least one of the expected properties are present
      expect(state.circular.fields).to.deep.include({
        regex: { type: 'RegExp', value: '/foo/' }
      })
    })

    it('non-enumerable property', function () {
      expect(state).to.have.deep.property('hidden', { type: 'string', value: 'secret' })
    })
  })
})
