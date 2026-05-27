'use strict'

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

      const rcConfig = t.generateRemoteConfig({ captureSnapshot: true })
      const promise = new Promise((resolve) => {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot } }] }) => {
          if (snapshot.probe.id === rcConfig.config.id) resolve(snapshot)
        })
      })

      t.agent.addRemoteConfig(rcConfig)

      const { captures } = await promise
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

      const rcConfig = t.generateRemoteConfig({ captureSnapshot: true })
      const promise = new Promise((resolve) => {
        t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot } }] }) => {
          if (snapshot.probe.id === rcConfig.config.id) resolve(snapshot)
        })
      })

      t.agent.addRemoteConfig(rcConfig)

      const { captures } = await promise
      const { locals } = captures.lines[t.breakpoint.line]

      assertObjectContains(locals, {
        secret: { type: 'string', value: 'shh!' },
        password: { type: 'string', notCapturedReason: 'redactedIdent' },
      })
    })
  })
})
