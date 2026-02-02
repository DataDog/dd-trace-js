'use strict'

const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const IastContextPlugin = require('../../../../src/appsec/iast/context/context-plugin')

const afterStartCh = dc.channel('dd-trace:kafkajs:consumer:afterStart')
const beforeFinishCh = dc.channel('dd-trace:kafkajs:consumer:beforeFinish')

describe('KafkaContextPlugin', () => {
  const message = { key: 'key', value: 'value' }
  let plugin
  let startContext, finishContext

  beforeEach(() => {
    startContext = sinon.stub(IastContextPlugin.prototype, 'startContext')
    finishContext = sinon.stub(IastContextPlugin.prototype, 'finishContext')

    plugin = proxyquire('../../../../src/appsec/iast/context/kafka-ctx-plugin', {
      './context-plugin': IastContextPlugin,
    })

    plugin.enable()
  })

  afterEach(() => {
    plugin.disable()
    sinon.restore()
  })

  it('should start iast context on dd-trace:kafkajs:consumer:afterStart', () => {
    afterStartCh.publish({ message })

    sinon.assert.calledOnce(startContext)
  })

  it('should finish iast context on dd-trace:kafkajs:consumer:beforeFinish', () => {
    beforeFinishCh.publish()

    sinon.assert.calledOnce(finishContext)
  })
})
