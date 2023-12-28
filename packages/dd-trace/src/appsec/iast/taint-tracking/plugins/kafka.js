'use strict'

const shimmer = require('../../../../../../datadog-shimmer')
const { storage } = require('../../../../../../datadog-core')
const { getIastContext } = require('../../iast-context')
const { KAFKA_VALUE, KAFKA_KEY } = require('../source-types')
const { newTaintedObject, newTaintedString } = require('../operations')
const { SourceIastPlugin } = require('../../iast-plugin')

class KafkaConsumerIastPlugin extends SourceIastPlugin {
  onConfigure () {
    this.addSub({ channelName: 'dd-trace:kafkajs:consumer:start', tag: [KAFKA_KEY, KAFKA_VALUE] },
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

      shimmer.wrap(key, 'toString',
        toString => this.getToStringWrap(toString, iastContext, 'key', KAFKA_KEY))
      shimmer.wrap(value, 'toString',
        toString => this.getToStringWrap(toString, iastContext, 'value', KAFKA_VALUE))

      newTaintedObject(iastContext, key, 'key', KAFKA_KEY)
      newTaintedObject(iastContext, value, 'value', KAFKA_VALUE)
    }
  }
}

module.exports = new KafkaConsumerIastPlugin()
