'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const NODE_20_PLUS = require('semver').gte(process.version, '20.0.0')

const { assertObjectContains } = require('../../../../../../integration-tests/helpers')
require('../../../setup/mocha')
const {
  session,
  getTargetCodePath,
  enable,
  teardown,
  setAndTriggerBreakpoint,
  getLocalStateForCallFrame,
  DEFAULT_CAPTURE_LIMITS,
} = require('./utils')

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
          { ...DEFAULT_CAPTURE_LIMITS, maxFieldCount: Number.MAX_SAFE_INTEGER })
        ).processLocalState())
      })

      await setAndTriggerBreakpoint(target, 10)

      state = await localState
    })

    it('should contain expected properties from closure scope', function () {
      assert.strictEqual(Object.keys(state).length, 28)

      // from block scope
      // ... tested individually in the remaining it-blocks inside this describe-block

      // from closure scope
      assert.ok('ref' in state)
      assert.deepStrictEqual(state.ref, {
        type: 'Object',
        fields: {
          wmo1: { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          wmo2: { type: 'Object', fields: { b: { type: 'number', value: '3' } } },
          wso1: { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          wso2: { type: 'Object', fields: { a: { type: 'number', value: '2' } } },
          wso3: { type: 'Object', fields: { a: { type: 'number', value: '3' } } },
        },
      })
      assert.ok('get' in state)
      assert.deepStrictEqual(state.get, {
        type: 'Function',
        fields: {
          length: { type: 'number', value: '0' },
          name: { type: 'string', value: 'get' },
        },
      })
    })

    it('object literal', function () {
      assert.ok('oblit' in state)
      assert.deepStrictEqual(state.oblit, {
        type: 'Object',
        fields: {
          a: { type: 'number', value: '1' },
          b_b: { type: 'number', value: '2' },
          'Symbol(c)': { type: 'number', value: '3' },
          d: { type: 'getter' },
          e: { type: 'getter' },
          f: { type: 'setter' },
          g: { type: 'getter/setter' },
        },
      })
    })

    it('custom object from class', function () {
      assert.ok('obnew' in state)
      assert.deepStrictEqual(state.obnew, {
        type: 'MyClass',
        fields: {
          foo: { type: 'number', value: '42' },
          '#secret': { type: 'number', value: '42' },
        },
      })
    })

    it('Array', function () {
      assert.ok('arr' in state)
      assert.deepStrictEqual(state.arr, {
        type: 'Array',
        elements: [
          { type: 'number', value: '1' },
          { type: 'number', value: '2' },
          { type: 'number', value: '3' },
        ],
      })
    })

    it('RegExp', function () {
      assert.ok('regex' in state)
      assert.deepStrictEqual(state.regex, { type: 'RegExp', value: '/foo/' })
    })

    it('Date', function () {
      assert.ok('date' in state)
      assert.deepStrictEqual(state.date, {
        type: 'Date',
        value: '2024-09-20T07:22:59Z', // missing milliseconds due to API limitation (should have been `998`)
      })
    })

    it('Map', function () {
      assert.ok('map' in state)
      assert.deepStrictEqual(state.map, {
        type: 'Map',
        entries: [
          [{ type: 'number', value: '1' }, { type: 'number', value: '2' }],
          [{ type: 'number', value: '3' }, { type: 'number', value: '4' }],
        ],
      })
    })

    it('Set', function () {
      assert.ok('set' in state)
      assert.deepStrictEqual(state.set, {
        type: 'Set',
        elements: [
          {
            type: 'Array',
            elements: [
              { type: 'number', value: '1' },
              { type: 'number', value: '2' },
            ],
          },
          { type: 'number', value: '3' },
          { type: 'number', value: '4' },
        ],
      })
    })

    it('WeakMap', function () {
      assert.ok(Object.hasOwn(state, 'wmap'))
      assert.strictEqual(Object.keys(state.wmap).length, (['type', 'entries']).length)
      assert.ok((['type', 'entries']).every(k => Object.hasOwn(state.wmap, k)))
      assert.ok(Array.isArray(state.wmap.entries))
      state.wmap.entries = state.wmap.entries.sort((a, b) => a[1].value - b[1].value)
      assert.ok('wmap' in state)
      assert.deepStrictEqual(state.wmap, {
        type: 'WeakMap',
        entries: [[
          { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          { type: 'number', value: '2' },
        ], [
          { type: 'Object', fields: { b: { type: 'number', value: '3' } } },
          { type: 'number', value: '4' },
        ]],
      })
    })

    it('WeakSet', function () {
      assert.ok(Object.hasOwn(state, 'wset'))
      assert.strictEqual(Object.keys(state.wset).length, (['type', 'elements']).length)
      assert.ok((['type', 'elements']).every(k => Object.hasOwn(state.wset, k)))
      assert.ok(Array.isArray(state.wset.elements))
      state.wset.elements = state.wset.elements.sort((a, b) => a.fields.a.value - b.fields.a.value)
      assert.ok('wset' in state)
      assert.deepStrictEqual(state.wset, {
        type: 'WeakSet',
        elements: [
          { type: 'Object', fields: { a: { type: 'number', value: '1' } } },
          { type: 'Object', fields: { a: { type: 'number', value: '2' } } },
          { type: 'Object', fields: { a: { type: 'number', value: '3' } } },
        ],
      })
    })

    it('Generator', function () {
      assert.ok('gen' in state)
      assert.deepStrictEqual(state.gen, {
        type: 'generator',
        fields: { foo: { type: 'number', value: '42' } },
      })
    })

    it('Error', function () {
      assert.ok(Object.hasOwn(state, 'err'))
      assert.strictEqual(Object.keys(state.err).length, (['type', 'fields']).length)
      assert.ok((['type', 'fields']).every(k => Object.hasOwn(state.err, k)))
      assert.strictEqual(state.err.type, 'CustomError')
      assert.ok(typeof state.err.fields === 'object' && state.err.fields !== null)
      assert.strictEqual(Object.keys(state.err.fields).length, (['stack', 'message', 'foo']).length)
      assert.ok((['stack', 'message', 'foo']).every(k => Object.hasOwn(state.err.fields, k)))
      assertObjectContains(state.err.fields, {
        message: { type: 'string', value: 'boom!' },
        foo: { type: 'number', value: '42' },
      })
      assert.strictEqual(Object.keys(state.err.fields.stack).length, (['type', 'value', 'truncated', 'size']).length)
      assert.ok((['type', 'value', 'truncated', 'size']).every(k => Object.hasOwn(state.err.fields.stack, k)))
      assert.strictEqual(typeof state.err.fields.stack.value, 'string')
      assert.match(state.err.fields.stack.value, /^Error: boom!/)
      assert.strictEqual(typeof state.err.fields.stack.size, 'number')
      assert.ok(((state.err.fields.stack.size) > (255)))
      assertObjectContains(state.err.fields.stack, {
        type: 'string',
        truncated: true,
      })
    })

    it('Function', function () {
      assert.ok('fn' in state)
      assert.deepStrictEqual(state.fn, {
        type: 'Function',
        fields: {
          foo: {
            type: 'Object',
            fields: { bar: { type: 'number', value: '42' } },
          },
          length: { type: 'number', value: '2' },
          name: { type: 'string', value: 'fnWithProperties' },
        },
      })
    })

    it('Bound function', function () {
      assert.ok('bfn' in state)
      assert.deepStrictEqual(state.bfn, {
        type: 'Function',
        fields: {
          length: { type: 'number', value: '0' },
          name: { type: 'string', value: 'bound fnWithProperties' },
        },
      })
    })

    it('Arrow function', function () {
      assert.ok('afn' in state)
      assert.deepStrictEqual(state.afn, {
        type: 'Function',
        fields: {
          length: { type: 'number', value: '0' },
          name: { type: 'string', value: 'afn' },
        },
      })
    })

    it('Class', function () {
      assert.ok('cls' in state)
      assert.deepStrictEqual(state.cls, { type: 'class MyClass' })
    })

    it('Anonymous class', function () {
      assert.ok('acls' in state)
      assert.deepStrictEqual(state.acls, { type: 'class' })
    })

    it('Proxy for object literal', function () {
      assert.ok('prox' in state)
      assert.deepStrictEqual(state.prox, {
        type: NODE_20_PLUS ? 'Proxy(Object)' : 'Proxy',
        fields: {
          target: { type: 'boolean', value: 'true' },
        },
      })
    })

    it('Proxy for custom class', function () {
      assert.ok('custProx' in state)
      assert.deepStrictEqual(state.custProx, {
        type: NODE_20_PLUS ? 'Proxy(MyClass)' : 'Proxy',
        fields: {
          foo: { type: 'number', value: '42' },
        },
      })
    })

    it('Promise: Pending', function () {
      assert.ok('pPen' in state)
      assert.deepStrictEqual(state.pPen, {
        type: 'Promise',
        fields: {
          '[[PromiseState]]': { type: 'string', value: 'pending' },
          '[[PromiseResult]]': { type: 'undefined' },
        },
      })
    })

    it('Promise: Resolved', function () {
      assert.ok('pRes' in state)
      assert.deepStrictEqual(state.pRes, {
        type: 'Promise',
        fields: {
          '[[PromiseState]]': { type: 'string', value: 'fulfilled' },
          '[[PromiseResult]]': { type: 'string', value: 'resolved value' },
        },
      })
    })

    it('Promise: Rejected', function () {
      assert.ok('pRej' in state)
      assert.deepStrictEqual(state.pRej, {
        type: 'Promise',
        fields: {
          '[[PromiseState]]': { type: 'string', value: 'rejected' },
          '[[PromiseResult]]': { type: 'string', value: 'rejected value' },
        },
      })
    })

    it('TypedArray', function () {
      assert.ok('tarr' in state)
      assert.deepStrictEqual(state.tarr, {
        type: 'Int8Array',
        elements: [
          { type: 'number', value: '72' },
          { type: 'number', value: '65' },
          { type: 'number', value: '76' },
        ],
      })
    })

    it('ArrayBuffer', function () {
      assert.ok('ab' in state)
      assert.deepStrictEqual(state.ab, {
        type: 'ArrayBuffer',
        value: 'HAL',
      })
    })

    it('SharedArrayBuffer', function () {
      assert.ok('sab' in state)
      assert.deepStrictEqual(state.sab, {
        type: 'SharedArrayBuffer',
        value: 'hello\x01\x02\x03world',
      })
    })

    it('circular reference in object', function () {
      assert.ok(Object.hasOwn(state, 'circular'))
      assert.strictEqual(state.circular.type, 'Object')
      assert.ok(Object.hasOwn(state.circular, 'fields'))
      // For the circular field, just check that at least one of the expected properties are present
      assertObjectContains(state.circular.fields, {
        regex: { type: 'RegExp', value: '/foo/' },
      })
    })

    it('non-enumerable property', function () {
      assert.ok('hidden' in state)
      assert.deepStrictEqual(state.hidden, { type: 'string', value: 'secret' })
    })
  })
})
