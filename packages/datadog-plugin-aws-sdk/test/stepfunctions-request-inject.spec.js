'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const Stepfunctions = require('../src/services/stepfunctions')

/**
 * `Object.create(Stepfunctions.prototype)` skips the heavy plugin /
 * diagnostic-channel wiring in `BaseAwsSdkPlugin`'s constructor. The method
 * under test only reads `this.tracer.inject`, so a hand-rolled stub is
 * enough to exercise the `requestInject` shape gate.
 *
 * @param {(span: unknown, format: string, info: object) => void} [inject]
 * @returns {Stepfunctions}
 */
function buildPlugin (inject = (span, format, info) => { info['x-datadog-trace-id'] = '123' }) {
  const plugin = Object.create(Stepfunctions.prototype)
  plugin._tracer = { inject }
  return plugin
}

describe('Stepfunctions plugin requestInject', () => {
  for (const operation of ['startExecution', 'startSyncExecution']) {
    describe(operation, () => {
      it('injects context into a JSON object payload with no whitespace', () => {
        const plugin = buildPlugin()
        const request = { operation, params: { input: '{"a":1}' } }

        plugin.requestInject(null, request)

        assert.deepStrictEqual(JSON.parse(request.params.input), {
          a: 1,
          _datadog: { 'x-datadog-trace-id': '123' },
        })
      })

      it('injects context when the JSON payload has trailing whitespace', () => {
        // Regression: the cheap shape gate used to require the literal
        // last byte to be `}`, dropping context propagation for any payload
        // serialized with trailing whitespace (e.g. `\n` from a formatter
        // or a custom serializer).
        const plugin = buildPlugin()
        const request = { operation, params: { input: '{"a":1}\n' } }

        plugin.requestInject(null, request)

        assert.deepStrictEqual(JSON.parse(request.params.input), {
          a: 1,
          _datadog: { 'x-datadog-trace-id': '123' },
        })
      })

      it('injects context for an empty JSON object', () => {
        const plugin = buildPlugin()
        const request = { operation, params: { input: '{}' } }

        plugin.requestInject(null, request)

        assert.deepStrictEqual(JSON.parse(request.params.input), {
          _datadog: { 'x-datadog-trace-id': '123' },
        })
      })

      it('skips injection for a JSON array payload', () => {
        const plugin = buildPlugin()
        const request = { operation, params: { input: '[1,2,3]' } }

        plugin.requestInject(null, request)

        assert.strictEqual(request.params.input, '[1,2,3]')
      })

      it('skips injection for a JSON string primitive payload', () => {
        const plugin = buildPlugin()
        const request = { operation, params: { input: '"hello"' } }

        plugin.requestInject(null, request)

        assert.strictEqual(request.params.input, '"hello"')
      })

      it('skips injection for a non-string input', () => {
        const plugin = buildPlugin()
        const request = { operation, params: { input: 42 } }

        plugin.requestInject(null, request)

        assert.strictEqual(request.params.input, 42)
      })

      it('skips injection when the trimmed payload is shorter than 2 bytes', () => {
        const plugin = buildPlugin()
        const request = { operation, params: { input: '} ' } }

        plugin.requestInject(null, request)

        assert.strictEqual(request.params.input, '} ')
      })
    })
  }

  it('skips other operations entirely', () => {
    const plugin = buildPlugin()
    const request = { operation: 'describeExecution', params: { input: '{"a":1}' } }

    plugin.requestInject(null, request)

    assert.strictEqual(request.params.input, '{"a":1}')
  })

  it('skips injection when params or input is missing', () => {
    const plugin = buildPlugin()
    const request = { operation: 'startExecution', params: {} }

    plugin.requestInject(null, request)

    assert.deepStrictEqual(request.params, {})
  })
})
