'use strict'

const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')
const IastContextPlugin = require('../../../../src/appsec/iast/context/context-plugin')

const consumerStartCh = dc.channel('dd-trace:kafkajs:consumer:start')
const consumerFinishCh = dc.channel('dd-trace:kafkajs:consumer:finish')

describe('KafkaContextPlugin', () => {
  const message = { key: 'key', value: 'value' }
  let plugin
  let startContext, finishContext

  beforeEach(() => {
    startContext = sinon.stub(IastContextPlugin.prototype, 'startContext')
    finishContext = sinon.stub(IastContextPlugin.prototype, 'finishContext')

    plugin = proxyquire('../../../../src/appsec/iast/context/kafka-ctx-plugin', {
      './context-plugin': IastContextPlugin
    })

    plugin.enable()
  })

  afterEach(() => {
    plugin.disable()
    sinon.restore()
  })

  it('should start iast context on dd-trace:kafkajs:consumer:start', () => {
    consumerStartCh.publish({ message })

    expect(startContext).to.be.calledOnce
  })

  it('should finish iast context on dd-trace:kafkajs:consumer:finish', () => {
    consumerFinishCh.publish()

    expect(finishContext).to.be.calledOnce
  })
})
