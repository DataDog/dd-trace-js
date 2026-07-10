'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const Sns = require('../src/services/sns')

/**
 * @param {object} options
 * @param {boolean} [options.dsmEnabled]
 * @param {() => object | undefined} [options.inject]
 * @param {object} [options.dataStreamsContext]
 * @returns {Sns}
 */
function buildPlugin ({
  dsmEnabled = false,
  inject = () => undefined,
  dataStreamsContext,
} = {}) {
  const tracer = {
    inject,
    setCheckpoint: () => dataStreamsContext,
  }
  const plugin = new Sns(tracer, {})
  plugin.config = { dsmEnabled }
  return plugin
}

describe('Sns plugin injectToMessage', () => {
  it('attaches a lazily injected trace carrier', () => {
    const traceContext = { 'x-datadog-trace-id': '123' }
    const plugin = buildPlugin({ inject: () => traceContext })
    const params = {
      Message: 'hello',
      MessageAttributes: {
        _datadog: { DataType: 'String', StringValue: 'old' },
      },
    }

    plugin.injectToMessage(null, params, 'arn:aws:sns:us-east-1:123456789012:topic', true)

    assert.strictEqual(params.MessageAttributes._datadog.DataType, 'Binary')
    assert.deepStrictEqual(
      JSON.parse(params.MessageAttributes._datadog.BinaryValue.toString()),
      traceContext
    )
  })

  it('does not attach an attribute when trace injection writes nothing', () => {
    const plugin = buildPlugin()
    const params = { Message: 'hello' }

    plugin.injectToMessage(null, params, 'arn:aws:sns:us-east-1:123456789012:topic', true)

    assert.deepStrictEqual(params.MessageAttributes, {})
  })

  it('lazily creates a carrier for DSM context', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    })
    const params = { Message: 'hello' }

    plugin.injectToMessage(null, params, 'arn:aws:sns:us-east-1:123456789012:topic', false)

    const carrier = JSON.parse(params.MessageAttributes._datadog.BinaryValue.toString())
    assert.strictEqual(typeof carrier['dd-pathway-ctx-base64'], 'string')
  })

  it('removes the DSM size placeholder when no context is available', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const params = { Message: 'hello' }

    plugin.injectToMessage(null, params, 'arn:aws:sns:us-east-1:123456789012:topic', false)

    assert.deepStrictEqual(params.MessageAttributes, {})
  })
})
