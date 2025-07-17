'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { DsmPathwayCodec, getMessageSize } = require('../../dd-trace/src/datastreams')

const BOOTSTRAP_SERVERS_KEY = 'messaging.kafka.bootstrap.servers'
const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class KafkajsProducerPlugin extends ProducerPlugin {
  static get id () { return 'kafkajs' }
  static get operation () { return 'produce' }
  static get peerServicePrecursors () { return [BOOTSTRAP_SERVERS_KEY] }

  constructor () {
    super(...arguments)
    this.addSub(`apm:${this.constructor.id}:produce:commit`, message => this.commit(message))
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
  commit (ctx) {
    const commitList = ctx.result

    if (!this.config.dsmEnabled) return
    if (!commitList || !Array.isArray(commitList)) return
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

  bindStart (ctx) {
    const { topic, messages, bootstrapServers, clusterId, disableHeaderInjection } = ctx
    const span = this.startSpan({
      resource: topic,
      meta: {
        component: this.constructor.id,
        'kafka.topic': topic,
        'kafka.cluster_id': clusterId,
        [MESSAGING_DESTINATION_KEY]: topic
      },
      metrics: {
        'kafka.batch_size': messages.length
      }
    }, ctx)
    if (bootstrapServers) {
      span.setTag(BOOTSTRAP_SERVERS_KEY, bootstrapServers)
    }
    for (const message of messages) {
      if (message !== null && typeof message === 'object') {
        // message headers are not supported for kafka broker versions <0.11
        if (!disableHeaderInjection) {
          message.headers ??= {}
          this.tracer.inject(span, 'text_map', message.headers)
        }
        if (this.config.dsmEnabled) {
          const payloadSize = getMessageSize(message)
          const edgeTags = ['direction:out', `topic:${topic}`, 'type:kafka']

          if (clusterId) {
            edgeTags.push(`kafka_cluster_id:${clusterId}`)
          }

          const dataStreamsContext = this.tracer.setCheckpoint(edgeTags, span, payloadSize)
          if (!disableHeaderInjection) {
            DsmPathwayCodec.encode(dataStreamsContext, message.headers)
          }
        }
      }
    }

    return ctx.currentStore
  }
}

module.exports = KafkajsProducerPlugin
