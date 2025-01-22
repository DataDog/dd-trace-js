'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

// Default settings is tested in unit tests, so we only need to test the env vars here
describe('Dynamic Instrumentation snapshot PII redaction', function () {
  describe('DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS=foo,bar', function () {
    const t = setup({ env: { DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: 'foo,bar' } })

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS', function (done) {
      t.triggerBreakpoint()

      t.agent.on('debugger-input', ({ payload: [{ 'debugger.snapshot': { captures } }] }) => {
        const { locals } = captures.lines[t.breakpoint.line]

        assert.deepPropertyVal(locals, 'foo', { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.deepPropertyVal(locals, 'bar', { type: 'string', notCapturedReason: 'redactedIdent' })
        assert.deepPropertyVal(locals, 'baz', { type: 'string', value: 'c' })

        // existing redaction should not be impacted
        assert.deepPropertyVal(locals, 'secret', { type: 'string', notCapturedReason: 'redactedIdent' })

        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))
    })
  })

  describe('DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS=secret', function () {
    const t = setup({ env: { DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: 'secret' } })

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS', function (done) {
      t.triggerBreakpoint()

      t.agent.on('debugger-input', ({ payload: [{ 'debugger.snapshot': { captures } }] }) => {
        const { locals } = captures.lines[t.breakpoint.line]

        assert.deepPropertyVal(locals, 'secret', { type: 'string', value: 'shh!' })
        assert.deepPropertyVal(locals, 'password', { type: 'string', notCapturedReason: 'redactedIdent' })

        done()
      })

      t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))
    })
  })
})
