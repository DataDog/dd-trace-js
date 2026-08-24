'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
const { NODE_MAJOR } = require('../../version')
const { setup } = require('./utils')

// Backported across LTS lines, so detect at runtime instead of version-gating.
const HAS_BRACKETED_BYTELENGTH = inspect(new ArrayBuffer(0)).includes('[byteLength]')

describe('Dynamic Instrumentation', function () {
  describe('template evaluation', function () {
    const t = setup({ dependencies: ['fastify'] })

    beforeEach(() => { t.triggerBreakpoint() })

    it('should evaluate template if it requires evaluation', function (done) {
      t.agent.on('debugger-input', ({ payload: [payload] }) => {
        assert.strictEqual(payload.message, 'Hello foo!')
        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: 'Hello {request.params.name}!',
        segments: [
          { str: 'Hello ' },
          {
            dsl: 'request.params.name',
            json: { getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] },
          },
          { str: '!' },
        ],
      }))
    })

    it('should properly stringify objects if a segment returns a non-string value', function (done) {
      t.agent.on('debugger-input', ({ payload: [payload] }) => {
        const messages = payload.message.split(';')

        assert.strictEqual(messages.shift(), 'null')
        assert.strictEqual(messages.shift(), 'undefined')
        assert.strictEqual(messages.shift(), 'true')
        assert.strictEqual(messages.shift(), '42')
        assert.strictEqual(messages.shift(), '42n')
        assert.strictEqual(messages.shift(), 'foo')
        assert.strictEqual(messages.shift(), 'Symbol(foo)')
        assert.strictEqual(messages.shift(), '/bar/i')
        assert.strictEqual(messages.shift(), '[]')
        assert.strictEqual(messages.shift(), '[ [Object], 2, 3, ... 2 more items ]')
        assert.strictEqual(messages.shift(), '{}')
        assert.strictEqual(messages.shift(), '{ a: 1, b: 2, c: 3, d: 4, e: 5 }')
        const obj = messages.shift()
        const expectedObjectShape = '{ ' +
          'foo: [Object], bar: true, baz: [Getter], qux: 42, quux: false, ... 1 more property ' +
        '}'
        assert.strictEqual(obj, expectedObjectShape)
        assert.strictEqual(messages.shift(), '[Proxy]')
        assert.strictEqual(messages.shift(), '{ a: 1, b: 2, c: 3, d: 4, e: 5, ... 1 more property }')
        assert.strictEqual(messages.shift(), '[Value omitted: inspection may execute user code]')
        assert.strictEqual(messages.shift(), '<ref *1> { circular: [Circular *1] }')
        assert.strictEqual(
          messages.shift(),
          '<ref *1> { circular: [Circular *1], a: 1, b: 2, c: 3, d: 4, ... 1 more property }'
        )
        assert.strictEqual(messages.shift(), '[class CustomClass]')
        assert.strictEqual(messages.shift(), '{ b: 2, c: 3, d: 4, e: 5, f: 6, ... 1 more property }')
        if (NODE_MAJOR >= 24) {
          assert.strictEqual(messages.shift(), 'Promise { 42 }')
        } else {
          // Full promise example string (line breaks added for readability):
          // Promise {
          //   42,
          //   [Symbol(async_id_symbol)]: 205,
          //   [Symbol(trigger_async_id_symbol)]: 204,
          //   [Symbol(kResourceStore)]: {}
          // }
          assert.match(messages.shift(), /^Promise \{ 42, /)
        }
        assert.strictEqual(messages.shift(), '[Function: arrowFn]')
        assert.strictEqual(messages.shift(), '[Function: fn]')
        assert.strictEqual(messages.shift(), 'Set(5) { 1, 2, 3, ... 2 more items }')
        assert.strictEqual(messages.shift(), 'Map(5) { 1 => 2, 3 => 4, 5 => 6, ... 2 more items }')
        assert.strictEqual(messages.shift(), 'WeakSet { <items unknown> }')
        assert.strictEqual(messages.shift(), 'WeakMap { <items unknown> }')
        assert.strictEqual(messages.shift(), 'Buffer(6) [Uint8Array] [ 102, 111, 111, ... 3 more items ]')
        assert.match(messages.shift(), /^Error: foo\n {4}at/)
        assert.strictEqual(
          messages.shift(),
          'ArrayBuffer { ' +
            '[Uint8Contents]: <00 00 00 ... 7 more bytes>, ' +
            (HAS_BRACKETED_BYTELENGTH ? '[byteLength]' : 'byteLength') +
              ": 10, '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9 " +
          '}'
        )
        assert.strictEqual(messages.shift(), 'Uint8Array(10) [ 0, 0, 0, ... 7 more items ]')

        assert.strictEqual(messages.length, 0)

        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        segments: [
          { dsl: 'nil', json: { ref: 'nil' } },
          { str: ';' },
          { dsl: 'undef', json: { ref: 'undef' } },
          { str: ';' },
          { dsl: 'bool', json: { ref: 'bool' } },
          { str: ';' },
          { dsl: 'num', json: { ref: 'num' } },
          { str: ';' },
          { dsl: 'bigint', json: { ref: 'bigint' } },
          { str: ';' },
          { dsl: 'str', json: { ref: 'str' } },
          { str: ';' },
          { dsl: 'sym', json: { ref: 'sym' } },
          { str: ';' },
          { dsl: 'regex', json: { ref: 'regex' } },
          { str: ';' },
          { dsl: 'emptyArr', json: { ref: 'emptyArr' } },
          { str: ';' },
          { dsl: 'arr', json: { ref: 'arr' } },
          { str: ';' },
          { dsl: 'emptyObj', json: { ref: 'emptyObj' } },
          { str: ';' },
          { dsl: 'maxObj', json: { ref: 'maxObj' } },
          { str: ';' },
          { dsl: 'obj', json: { ref: 'obj' } },
          { str: ';' },
          { dsl: 'proxy', json: { ref: 'proxy' } },
          { str: ';' },
          { dsl: 'objectWithProxyPrototype', json: { ref: 'objectWithProxyPrototype' } },
          { str: ';' },
          { dsl: 'sideEffectfulObject', json: { ref: 'sideEffectfulObject' } },
          { str: ';' },
          { dsl: 'circular', json: { ref: 'circular' } },
          { str: ';' },
          { dsl: 'wideCircular', json: { ref: 'wideCircular' } },
          { str: ';' },
          { dsl: 'CustomClass', json: { ref: 'CustomClass' } },
          { str: ';' },
          { dsl: 'ins', json: { ref: 'ins' } },
          { str: ';' },
          { dsl: 'p', json: { ref: 'p' } },
          { str: ';' },
          { dsl: 'arrowFn', json: { ref: 'arrowFn' } },
          { str: ';' },
          { dsl: 'fn', json: { ref: 'fn' } },
          { str: ';' },
          { dsl: 'set', json: { ref: 'set' } },
          { str: ';' },
          { dsl: 'map', json: { ref: 'map' } },
          { str: ';' },
          { dsl: 'wset', json: { ref: 'wset' } },
          { str: ';' },
          { dsl: 'wmap', json: { ref: 'wmap' } },
          { str: ';' },
          { dsl: 'buf', json: { ref: 'buf' } },
          { str: ';' },
          { dsl: 'err', json: { ref: 'err' } },
          { str: ';' },
          { dsl: 'abuf', json: { ref: 'abuf' } },
          { str: ';' },
          { dsl: 'tarr', json: { ref: 'tarr' } },
        ],
      }))
    })

    it('should trim long messages', function (done) {
      t.agent.on('debugger-input', ({ payload }) => {
        assert.strictEqual(payload.length, 2)
        payload.forEach((payload) => {
          assert.strictEqual(payload.message.length, 8 * 1024 + 1) // 1 extra char for the ellipsis
          assert.strictEqual(payload.message, '0123456789'.repeat(1000).slice(0, 8 * 1024) + '…')
        })
        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: '0123456789'.repeat(1000),
      }))

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        segments: [
          { dsl: 'lstr', json: { ref: 'lstr' } },
        ],
      }))
    })

    it('should report evaluation errors for each template segment that cannot be evaluated', function (done) {
      t.agent.on('debugger-input', ({ payload: [payload] }) => {
        assert.strictEqual(
          payload.message,
          'This should fail: {TypeError: Cannot convert undefined or null to object}, ' +
            'this should work: foo, ' +
            'and this should fail: {ReferenceError: invalid is not defined}'
        )

        const { evaluationErrors } = payload.debugger.snapshot

        assert.ok(Array.isArray(evaluationErrors), `Expected array, got ${inspect(evaluationErrors)}`)
        assert.strictEqual(evaluationErrors.length, 2)
        assert.strictEqual(evaluationErrors[0].expr, 'request.invalid.name')
        assert.strictEqual(evaluationErrors[0].message, 'TypeError: Cannot convert undefined or null to object')
        assert.strictEqual(evaluationErrors[1].expr, 'invalid')
        assert.strictEqual(evaluationErrors[1].message, 'ReferenceError: invalid is not defined')
        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: 'This should fail: {request.invalid.name}, ' +
          'this should work: {request.params.name}, ' +
          'and this should fail: {invalid}',
        segments: [
          { str: 'This should fail: ' },
          {
            dsl: 'request.invalid.name',
            json: { getmember: [{ getmember: [{ ref: 'request' }, 'invalid'] }, 'name'] },
          },
          { str: ', this should work: ' },
          {
            dsl: 'request.params.name',
            json: { getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] },
          },
          { str: ', and this should fail: ' },
          {
            dsl: 'invalid',
            json: { ref: 'invalid' },
          },
        ],
      }))
    })
  })
})
