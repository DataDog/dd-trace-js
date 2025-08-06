'use strict'

process.env.DD_INJECTION_ENABLED = 'true'

const { telemetryForwarder, assertTelemetryPoints } = require('../../../../integration-tests/helpers')

describe('sendTelemetry', () => {
  let cleanup, sendTelemetry

  before(function () {
    if (['1', 'true', 'True'].includes(process.env.DD_INJECT_FORCE)) {
      // When DD_INJECT_FORCE is set, only telemetry with the name `error` or `complete` is sent
      this.skip()
    }
  })

  beforeEach(() => {
    cleanup = telemetryForwarder()
    sendTelemetry = proxyquire('../src/guardrails/telemetry', {})
  })

  it('should send telemetry', async () => {
    sendTelemetry([
      { name: 'abort', tags: ['1'] },
      { name: 'abort.integration', tags: ['2'] },
      { name: 'abort.integration', tags: ['3'] },
      { name: 'foo', tags: ['4'] }
    ])
    const msgs = await cleanup()
    assertTelemetryPoints(process.pid, msgs, [
      'abort', '1',
      'abort.integration', '2',
      'abort.integration', '3',
      'foo', '4'
    ])
  })

  describe('no duplicates', () => {
    it('should not send `abort` more than once in the same call', async () => {
      sendTelemetry([
        { name: 'abort', tags: ['1'] },
        { name: 'abort', tags: ['2'] }
      ])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort', '1'])
    })

    it('should not send `abort` more than once in a different call', async () => {
      sendTelemetry('abort', ['1'])
      sendTelemetry('abort', ['2'])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort', '1'])
    })

    it('should not send `abort.integration` more than once if tags are the same in the same call', async () => {
      sendTelemetry([
        { name: 'abort.integration', tags: ['1'] },
        { name: 'abort.integration', tags: ['1'] }
      ])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort.integration', '1'])
    })

    it('should not send `abort.integration` more than once if tags are the same in a different call', async () => {
      sendTelemetry('abort.integration', ['1'])
      sendTelemetry('abort.integration', ['1'])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort.integration', '1'])
    })
  })
})
