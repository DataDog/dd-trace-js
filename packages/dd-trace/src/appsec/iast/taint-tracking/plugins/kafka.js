'use strict'

const shimmer = require('../../../../../../datadog-shimmer')
const { storage } = require('../../../../../../datadog-core')
const { getIastContext } = require('../../iast-context')
const { KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE } = require('../source-types')
const { newTaintedObject, newTaintedString } = require('../operations')
const { SourceIastPlugin } = require('../../iast-plugin')

class KafkaConsumerIastPlugin extends SourceIastPlugin {
  onConfigure () {
    this.addSub({ channelName: 'dd-trace:kafkajs:consumer:start', tag: [KAFKA_MESSAGE_KEY, KAFKA_MESSAGE_VALUE] },
      ({ message }) => this.taintKafkaMessage(message)
    )
  }

  getToStringWrap (toString, iastContext, name, type) {
    return function () {
      const res = toString.apply(this, arguments)
      return newTaintedString(iastContext, res, name, type)
    }
  }

  taintKafkaMessage (message) {
    const iastContext = getIastContext(storage.getStore())

    if (iastContext) {
      const { key, value } = message

      if (key && typeof key === 'object') {
        shimmer.wrap(key, 'toString',
          toString => this.getToStringWrap(toString, iastContext, 'key', KAFKA_MESSAGE_KEY))

        newTaintedObject(iastContext, key, 'key', KAFKA_MESSAGE_KEY)
      }

      if (value && typeof value === 'object') {
        shimmer.wrap(value, 'toString',
          toString => this.getToStringWrap(toString, iastContext, 'value', KAFKA_MESSAGE_VALUE))

        newTaintedObject(iastContext, value, 'value', KAFKA_MESSAGE_VALUE)
      }
    }
  }
}

module.exports = new KafkaConsumerIastPlugin()
