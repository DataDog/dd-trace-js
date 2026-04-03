'use strict'

const assert = require('node:assert/strict')
require('../../../setup/mocha')
const { getTargetCodePath, enable, teardown, assertOnBreakpoint, setAndTriggerBreakpoint } = require('./utils')

const target = getTargetCodePath(__filename)
const BREAKPOINT_LINE_NUMBER = 32

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('redaction', function () {
    beforeEach(enable(__filename))

    afterEach(teardown)

    // Non-default configuration is tested in the integration tests
    it('should replace PII in keys/properties/variables with expected notCapturedReason', function (done) {
      assertOnBreakpoint(done, (state) => {
        assert.deepStrictEqual(
          Object.keys(state).sort(),
          [
            'Se_cret_$',
            'foo',
            'nonNormalizedSecretToken',
            'obj',
            'secret',
            'weakMapKey',
          ]
        )

        assert.ok('foo' in state)
        assert.deepStrictEqual(state.foo, { type: 'string', value: 'bar' })
        assert.ok('secret' in state)
        assert.deepStrictEqual(state.secret, { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.ok('Se_cret_$' in state)
        assert.deepStrictEqual(state.Se_cret_$, { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.ok('weakMapKey' in state)
        assert.deepStrictEqual(state.weakMapKey, {
          type: 'Object',
          fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } },
        })
        assert.ok('obj' in state)
        assert.strictEqual(state.obj.type, 'Object')

        const { fields } = state.obj
        assert.deepStrictEqual(
          Object.keys(fields),
          [
            'foo',
            'secret',
            '@Se-cret_$_',
            'nested',
            'arr',
            'map',
            'weakmap',
            'password',
            'Symbol(secret)',
            'Symbol(@Se-cret_$_)',
          ]
        )

        assert.ok('foo' in fields)
        assert.deepStrictEqual(fields.foo, { type: 'string', value: 'bar' })
        assert.ok('secret' in fields)
        assert.deepStrictEqual(fields.secret, { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.ok('@Se-cret_$_' in fields)
        assert.deepStrictEqual(fields['@Se-cret_$_'], { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.ok('nested' in fields)
        assert.deepStrictEqual(fields.nested, {
          type: 'Object',
          fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } },
        })
        assert.ok('arr' in fields)
        assert.deepStrictEqual(fields.arr, {
          type: 'Array',
          elements: [{ type: 'Object', fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } } }],
        })
        assert.ok('map' in fields)
        assert.deepStrictEqual(fields.map, {
          type: 'Map',
          entries: [
            [
              { type: 'string', value: 'foo' },
              { type: 'string', value: 'bar' },
            ],
            [
              { type: 'string', value: 'secret' },
              { type: 'string', notCapturedReason: 'redactedIdent' },
            ],
            [
              { type: 'string', value: '@Se-cret_$.' },
              { type: 'string', notCapturedReason: 'redactedIdent' },
            ],
            [
              { type: 'symbol', value: 'Symbol(secret)' },
              { type: 'string', notCapturedReason: 'redactedIdent' },
            ],
            [
              { type: 'symbol', value: 'Symbol(@Se-cret_$.)' },
              { notCapturedReason: 'redactedIdent', type: 'string' },
            ],
          ],
        })
        assert.ok('weakmap' in fields)
        assert.deepStrictEqual(fields.weakmap, {
          type: 'WeakMap',
          entries: [[
            { type: 'Object', fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } } },
            { type: 'number', value: '42' },
          ]],
        })
        assert.ok('password' in fields)
        assert.deepStrictEqual(fields.password, { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.ok('Symbol(secret)' in fields)
        assert.deepStrictEqual(fields['Symbol(secret)'], { type: 'string', notCapturedReason: 'redactedIdent' })
      })

      setAndTriggerBreakpoint(target, BREAKPOINT_LINE_NUMBER)
    })
  })
})
