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

    it('should redact the configured identifiers in log templates', async function () {
      const message = await getLogMessage(t, ['foo', 'baz', 'secret', 'obj'])

      assert.strictEqual(
        message,
        "foo={redacted};baz=c;secret={redacted};obj={ foo: '{redacted}', baz: 'c', secret: '{redacted}', " +
          "password: '{redacted}' }"
      )
    })

    it('should redact the configured identifiers in capture expressions', async function () {
      const { captures, evaluationErrors } = await getCaptureExpressionsSnapshot(t, ['foo', 'baz', 'secret'])

      assert.deepStrictEqual(captures.lines[t.breakpoint.line].captureExpressions, {
        baz: { type: 'string', value: 'c' },
      })
      assert.deepStrictEqual(evaluationErrors, [
        { expr: 'foo', message: "Could not evaluate the expression because 'foo' was redacted" },
        { expr: 'secret', message: "Could not evaluate the expression because 'secret' was redacted" },
      ])
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

    it('should not redact the excluded identifiers in log templates', async function () {
      const message = await getLogMessage(t, ['secret', 'password', 'obj'])

      assert.strictEqual(
        message,
        "secret=shh!;password={redacted};obj={ foo: 'a', baz: 'c', secret: 'shh!', password: '{redacted}' }"
      )
    })

    it('should not redact the excluded identifiers in capture expressions', async function () {
      const { captures, evaluationErrors } = await getCaptureExpressionsSnapshot(t, ['secret', 'password'])

      assert.deepStrictEqual(captures.lines[t.breakpoint.line].captureExpressions, {
        secret: { type: 'string', value: 'shh!' },
      })
      assert.deepStrictEqual(evaluationErrors, [
        { expr: 'password', message: "Could not evaluate the expression because 'password' was redacted" },
      ])
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

/**
 * Add a probe capturing each of the given identifiers as a capture expression, and return the emitted snapshot.
 *
 * @param {ReturnType<typeof setup>} t - The test environment.
 * @param {string[]} identifiers - The identifiers to capture.
 */
async function getCaptureExpressionsSnapshot (t, identifiers) {
  t.triggerBreakpoint()

  const promise = once(t.agent, 'debugger-input')

  t.agent.addRemoteConfig(t.generateRemoteConfig({
    captureExpressions: identifiers.map((identifier) => ({
      name: identifier,
      expr: { dsl: identifier, json: { ref: identifier } },
    })),
  }))

  const [{ payload: [{ debugger: { snapshot } }] }] = await promise
  return snapshot
}
