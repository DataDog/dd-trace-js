'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { SourceIastPlugin } = require('../../../../../src/appsec/iast/iast-plugin')
const { KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE } = require('../../../../../src/appsec/iast/taint-tracking/source-types')

describe('Kafka consumer plugin', () => {
  let kafkaConsumerPlugin
  let addSub, handler
  let getIastContext
  let newTaintedObject, newTaintedString
  let iastContext

  beforeEach(() => {
    addSub = sinon.stub(SourceIastPlugin.prototype, 'addSub')
    newTaintedObject = sinon.stub()
    newTaintedString = sinon.stub().callsFake((arg0, arg1) => arg1)

    iastContext = {}
    getIastContext = sinon.stub().returns(iastContext)

    kafkaConsumerPlugin = proxyquire('../../../../../src/appsec/iast/taint-tracking/plugins/kafka', {
      '../../iast-plugin': {
        SourceIastPlugin
      },
      '../operations': {
        newTaintedObject,
        newTaintedString
      },
      '../../iast-context': {
        getIastContext
      }
    })

    kafkaConsumerPlugin.enable(true)

    handler = addSub.firstCall.args[1]
  })

  afterEach(sinon.restore)

  it('should subscribe to dd-trace:kafkajs:consumer:afterStart channel', () => {
    expect(addSub).to.be.calledOnceWith({
      channelName: 'dd-trace:kafkajs:consumer:afterStart',
      tag: [KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE]
    })
  })

  it('should taint kafka message', () => {
    const message = {
      key: Buffer.from('key'),
      value: Buffer.from('value')
    }

    handler({ message })

    expect(newTaintedObject).to.be.calledTwice

    expect(newTaintedObject.firstCall).to.be.calledWith(iastContext, message.key, undefined, KAFKA_MESSAGE_KEY)
    expect(newTaintedObject.secondCall).to.be.calledWith(iastContext, message.value, undefined, KAFKA_MESSAGE_VALUE)
  })

  it('should taint key Buffer.toString method', () => {
    const message = {
      key: Buffer.from('keyToString'),
      value: Buffer.from('valueToString')
    }

    handler({ message })

    const keyStr = message.key.toString()

    expect(newTaintedString).to.be.calledOnceWith(iastContext, keyStr, undefined, KAFKA_MESSAGE_KEY)
  })

  it('should taint value Buffer.toString method', () => {
    const message = {
      key: Buffer.from('keyToString'),
      value: Buffer.from('valueToString')
    }

    handler({ message })

    const valueStr = message.value.toString()

    expect(newTaintedString).to.be.calledOnceWith(iastContext, valueStr, undefined, KAFKA_MESSAGE_VALUE)
  })

  it('should not fail with an unknown kafka message', () => {
    const message = {}

    expect(() => {
      handler({ message })
    }).to.not.throw()
  })

  it('should not fail with an unknown kafka message II', () => {
    const message = {
      key: 'key'
    }

    expect(() => {
      handler({ message })
    }).to.not.throw()
  })
})
