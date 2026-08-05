'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { assertObjectContains } = require('../helpers')
const { setup } = require('./utils')

// Default settings is tested in unit tests, so we only need to test the env vars here
describe('Dynamic Instrumentation snapshot PII redaction', function () {
  describe('DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS=foo,bar', function () {
    const t = setup({
      env: { DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS: 'foo,bar' },
      dependencies: ['fastify'],
    })

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))

      const [{ payload: [{ debugger: { snapshot: { captures } } }] }] = await promise
      const { locals } = captures.lines[t.breakpoint.line]

      assertObjectContains(locals, {
        foo: { type: 'string', notCapturedReason: 'redactedIdent' },
        bar: { type: 'string', notCapturedReason: 'redactedIdent' },
        baz: { type: 'string', value: 'c' },
      })

      // existing redaction should not be impacted
      assertObjectContains(locals, { secret: { type: 'string', notCapturedReason: 'redactedIdent' } })
    })
  })

  describe('DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS=secret', function () {
    const t = setup({
      env: { DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS: 'secret' },
      dependencies: ['fastify'],
    })

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({ captureSnapshot: true }))

      const [{ payload: [{ debugger: { snapshot: { captures } } }] }] = await promise
      const { locals } = captures.lines[t.breakpoint.line]

      assertObjectContains(locals, {
        secret: { type: 'string', value: 'shh!' },
        password: { type: 'string', notCapturedReason: 'redactedIdent' },
      })
    })
  })

  describe('log probe message', function () {
    const t = setup({ dependencies: ['fastify'] })

    it('should redact sensitive identifiers when a template interpolates an object or map', async function () {
      t.triggerBreakpoint()

      const promise = once(t.agent, 'debugger-input')

      t.agent.addRemoteConfig(t.generateRemoteConfig({
        template: 'obj={obj};map={map}',
        segments: [
          { str: 'obj=' },
          { dsl: 'obj', json: { ref: 'obj' } },
          { str: ';map=' },
          { dsl: 'map', json: { ref: 'map' } },
        ],
      }))

      const [{ payload: [{ message }] }] = await promise

      assert.strictEqual(
        message,
        "obj={ username: 'alice', password: '[redacted]' };" +
          "map=Map(2) { 'username' => 'alice', 'password' => '[redacted]' }"
      )
    })
  })
})
