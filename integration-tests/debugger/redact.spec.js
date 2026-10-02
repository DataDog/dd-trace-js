'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { assertObjectContains } = require('../helpers')
const { setup } = require('./utils')

// Default settings is tested in unit tests, so we only need to test the env vars here
describe('Dynamic Instrumentation PII redaction', function () {
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

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS in log templates', async function () {
      const message = await getLogMessage(t, ['foo', 'baz', 'secret', 'obj'])

      assert.strictEqual(
        message,
        "foo={redacted};baz=c;secret={redacted};obj={ foo: '{redacted}', baz: 'c', secret: '{redacted}', " +
          "password: '{redacted}' }"
      )
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

    it('should respect DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS in log templates', async function () {
      const message = await getLogMessage(t, ['secret', 'password', 'obj'])

      assert.strictEqual(
        message,
        "secret=shh!;password={redacted};obj={ foo: 'a', baz: 'c', secret: 'shh!', password: '{redacted}' }"
      )
    })
  })
})

/**
 * Add a log probe whose template renders each of the given identifiers, and return the emitted log message.
 *
 * @param {ReturnType<typeof setup>} t - The test environment.
 * @param {string[]} identifiers - The identifiers to render, as `<identifier>=<value>` pairs separated by `;`.
 */
async function getLogMessage (t, identifiers) {
  t.triggerBreakpoint()

  const promise = once(t.agent, 'debugger-input')

  t.agent.addRemoteConfig(t.generateRemoteConfig({
    segments: identifiers.flatMap((identifier, index) => [
      { str: `${index === 0 ? '' : ';'}${identifier}=` },
      { dsl: identifier, json: { ref: identifier } },
    ]),
  }))

  const [{ payload: [{ message }] }] = await promise
  return message
}
