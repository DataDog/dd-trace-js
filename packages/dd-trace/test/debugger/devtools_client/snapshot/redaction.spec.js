'use strict'

require('../../../setup/mocha')

const { expect } = require('chai')
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
        expect(state).to.have.all.keys(
          'nonNormalizedSecretToken', 'foo', 'secret', 'Se_cret_$', 'weakMapKey', 'obj'
        )

        expect(state).to.have.deep.property('foo', { type: 'string', value: 'bar' })
        expect(state).to.have.deep.property('secret', { type: 'string', notCapturedReason: 'redactedIdent' })
        expect(state).to.have.deep.property('Se_cret_$', { type: 'string', notCapturedReason: 'redactedIdent' })
        expect(state).to.have.deep.property('weakMapKey', {
          type: 'Object',
          fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } }
        })
        expect(state).to.have.deep.property('obj')
        expect(state.obj).to.have.property('type', 'Object')

        const { fields } = state.obj
        expect(fields).to.have.all.keys(
          'foo', 'secret', '@Se-cret_$_', 'nested', 'arr', 'map', 'weakmap', 'password',
          'Symbol(secret)', 'Symbol(@Se-cret_$_)'
        )

        expect(fields).to.have.deep.property('foo', { type: 'string', value: 'bar' })
        expect(fields).to.have.deep.property('secret', { type: 'string', notCapturedReason: 'redactedIdent' })
        expect(fields).to.have.deep.property('@Se-cret_$_', { type: 'string', notCapturedReason: 'redactedIdent' })
        expect(fields).to.have.deep.property('nested', {
          type: 'Object',
          fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } }
        })
        expect(fields).to.have.deep.property('arr', {
          type: 'Array',
          elements: [{ type: 'Object', fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } } }]
        })
        expect(fields).to.have.deep.property('map', {
          type: 'Map',
          entries: [
            [
              { type: 'string', value: 'foo' },
              { type: 'string', value: 'bar' }
            ],
            [
              { type: 'string', value: 'secret' },
              { type: 'string', notCapturedReason: 'redactedIdent' }
            ],
            [
              { type: 'string', value: '@Se-cret_$.' },
              { type: 'string', notCapturedReason: 'redactedIdent' }
            ],
            [
              { type: 'symbol', value: 'Symbol(secret)' },
              { type: 'string', notCapturedReason: 'redactedIdent' }
            ],
            [
              { type: 'symbol', value: 'Symbol(@Se-cret_$.)' },
              { notCapturedReason: 'redactedIdent', type: 'string' }
            ]
          ]
        })
        expect(fields).to.have.deep.property('weakmap', {
          type: 'WeakMap',
          entries: [[
            { type: 'Object', fields: { secret: { type: 'string', notCapturedReason: 'redactedIdent' } } },
            { type: 'number', value: '42' }
          ]]
        })
        expect(fields).to.have.deep.property('password', { type: 'string', notCapturedReason: 'redactedIdent' })
        expect(fields).to.have.deep.property('Symbol(secret)', { type: 'string', notCapturedReason: 'redactedIdent' })
      })

      setAndTriggerBreakpoint(target, BREAKPOINT_LINE_NUMBER)
    })
  })
})
