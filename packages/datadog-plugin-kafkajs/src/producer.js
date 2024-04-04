'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const { getMessageSize } = require('../../dd-trace/src/datastreams/processor')

const BOOTSTRAP_SERVERS_KEY = 'messaging.kafka.bootstrap.servers'

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }
  static get peerServicePrecursors () { return [BOOTSTRAP_SERVERS_KEY] }

  constructor () {
    super(...arguments)
    this.addSub('apm:kafkajs:produce:commit', message => this.commit(message))
  }

  /**
   * Transform individual commit details sent by kafkajs' event reporter
   * into actionable backlog items for DSM
   *
   * @typedef {object} ProducerBacklog
   * @property {number} type
   * @property {string} topic
   * @property {number} partition
   * @property {number} offset
   *
   * @typedef {object} ProducerResponseItem
   * @property {string} topic
   * @property {number} partition
   * @property {import('kafkajs/utils/long').Long} [offset]
   * @property {import('kafkajs/utils/long').Long} [baseOffset]
   *
   * @param {ProducerResponseItem} response
   * @returns {ProducerBacklog}
   */
  transformProduceResponse (response) {
    // In produce protocol >=v3, the offset key changes from `offset` to `baseOffset`
    const { topicName: topic, partition, offset, baseOffset } = response
    const offsetAsLong = offset || baseOffset
    return {
      type: 'kafka_produce',
      partition,
      offset: offsetAsLong ? Number(offsetAsLong) : undefined,
      topic
    }
  }

  /**
   *
   * @param {ProducerResponseItem[]} commitList
   * @returns {void}
   */
  commit (commitList) {
    if (!this.config.dsmEnabled) return
    const keys = [
      'type',
      'partition',
      'offset',
      'topic'
    ]
    for (const commit of commitList.map(this.transformProduceResponse)) {
      if (keys.some(key => !commit.hasOwnProperty(key))) continue
      this.tracer.setOffset(commit)
    }
  }

  start ({ topic, messages, bootstrapServers }) {
    const span = this.startSpan({
      resource: topic,
      meta: {
        component: 'kafkajs',
        'kafka.topic': topic
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    })
    if (bootstrapServers) {
      span.setTag(BOOTSTRAP_SERVERS_KEY, bootstrapServers)
    }
    for (const message of messages) {
      if (typeof message === 'object') {
        this.tracer.inject(span, 'text_map', message.headers)
        if (this.config.dsmEnabled) {
          const payloadSize = getMessageSize(message)
          const dataStreamsContext = this.tracer
            .setCheckpoint(['direction:out', `topic:${topic}`, 'type:kafka'], span, payloadSize)
          DsmPathwayCodec.encode(dataStreamsContext, message.headers)
        }
      }
    }
  }
}

module.exports = KafkajsProducerPlugin
